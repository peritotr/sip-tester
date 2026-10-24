# Server setup guide

How to run the SIP Tester web edition on a Linux server and point it at a PBX or SIP server.

## 1. Pick the machine

- **Close to the PBX, not on it.** Same data centre or LAN, so network latency doesn't hide the server's own latency, but a separate machine so the tester and the PBX don't fight over CPU.
- **Size.** 2 vCPU / 2 GB RAM generate ~2,000 CPS of signalling with thousands of simultaneous calls. RTP is the expensive part: each media call is 50 packets/s each way, so 500 media calls ≈ 25,000 packets/s in each direction. Keep *RTP calls (max)* to a sample (100–300) unless the box is large.
- **Linux, Docker with Compose.** The container uses host networking (SIP and RTP ports are chosen at run time).

## 2. Install

```bash
mkdir sip-tester && cd sip-tester
curl -fsSLO https://raw.githubusercontent.com/peritotr/sip-tester/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/peritotr/sip-tester/main/.env.example -o .env
nano .env                    # set UI_PASSWORD (8+ characters); keep HOST=127.0.0.1
docker compose up -d
docker compose logs -f       # "SIP Tester web UI on http://127.0.0.1:8080"
```

Without Docker (Node 18+): `git clone …`, `npm install --omit=dev`, `UI_PASSWORD=… HOST=127.0.0.1 node server.js` (use systemd or pm2 to keep it running).

Raise the UDP buffers for high rates (the app asks for 8 MB per socket; the kernel caps it):

```bash
sudo sysctl -w net.core.rmem_max=16777216 net.core.wmem_max=16777216
```

## 3. Open the UI

Keep the UI off the public internet. Either an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 user@tester-server     # then http://localhost:8080
```

or an HTTPS reverse proxy (nginx / Caddy) in front of `127.0.0.1:8080` that forwards WebSocket upgrades on `/ws` and sets `X-Forwarded-Proto: https`.

## 4. Firewall

The tester starts every connection, so outbound traffic is what matters:

| Direction | Port | Why |
| --- | --- | --- |
| Tester → PBX | SIP port (UDP/TCP 5060 by default) | Requests |
| PBX → tester | The tester's SIP source port | Responses and in-dialog requests (BYE). Stateful firewalls allow it for UDP replies; set *Local SIP port* to a fixed value if yours doesn't. |
| PBX → tester | RTP ports | Media coming back. Set *RTP start port* (e.g. 30000) and open 30000–32000/udp if media must cross a firewall. |

Behind NAT, set *Contact IP* to the tester's public address so Via, Contact and SDP point back to it.

## 5. Prepare the PBX

1. **Test extensions**: e.g. 1000–1499, password `pw<extension>` (use the password template `pw{user}`) or one shared password.
2. **An answering destination**: an echo test (Asterisk `Answer()` + `Echo()`, FreeSWITCH `9196`) measures media both ways. An IVR or `Answer()` + `Wait()` works for signalling only.
3. **Remove limits that would distort the test** — or keep them deliberately and test them: per-extension call limits, fail2ban / pike / anti-flood on the tester's IP, max open files (Asterisk `maxfiles` in `asterisk.conf`), RTP port range (`rtp.conf`: at least 2 ports per simultaneous call).
4. **Never route test numbers to a trunk.**

## 6. A test plan

| # | Scenario | Settings | Answers |
| --- | --- | --- | --- |
| 1 | Single test | Connect, OPTIONS, Register, one 10 s call with RTP | Is the path, auth and media right? |
| 2 | Calls, constant | 5 CPS, 2 min, hold 20–40 s, RTP on 50 | Baseline PDD, ASR and media quality |
| 3 | Calls, step | 10 → 200 CPS, +10 per 60 s step, hold 20–40 s, RTP on 100 | The knee: highest clean CPS |
| 4 | Calls, soak | 70% of the knee for 30–60 min | Latency drift, dropped calls, leaks |
| 5 | Registrations | accounts 1000-1499, 100 → 500 RPS step, nonce reuse off | Registration storm after an outage |
| 6 | OPTIONS | 500 → 5,000 RPS step | Raw SIP stack throughput |

Start with acceptance criteria that match your SLA (e.g. PDD p95 ≤ 500 ms, ASR ≥ 99.5%, failures ≤ 0.5%, RTP loss ≤ 1%) so every report comes back PASSED or FAILED.

## 7. Reading the report

- **PDD rises but ASR stays 100%** → the server is getting slow (CPU, dialplan or database lookups) but not failing yet. The step before the rise is your clean capacity.
- **503 Service Unavailable** → the server is protecting itself (task-processor overload, licence or channel limits).
- **488 Not Acceptable Here / no audio** → media resources ran out: RTP ports, open files, transcoding or media relay capacity.
- **Retransmissions and timeouts** → packets are dropped or the server answers too late; check UDP buffers on both sides and the server's CPU.
- **Dropped calls** → the server hung up answered calls early: RTP timeouts, session timers, or a resource that ran out mid-call.

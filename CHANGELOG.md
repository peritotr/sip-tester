# Changelog

## 0.1.0 — preview

First version.

- SIP stack for load testing: UDP and TCP, digest auth (MD5 / SHA-256, qop=auth, nonce reuse), RFC 3261 retransmission timers, CANCEL, in-dialog BYE / re-INVITE handling
- Scenarios: calls (INVITE) with hold time, max ring and account rotation; registrations; OPTIONS
- Light RTP (G.711): loss, jitter, silent-call detection, echo round trip
- Constant and step tests, ramp-up, back-off on 503, several sockets / TCP connections
- Performance report with latency onset, saturation cause, step table, acceptance criteria, PDF / CSV / JSON
- Single-test view with a per-call SIP message log
- Built-in vendor (trunk): UDP + TCP, optional digest auth, ring/answer delays, CPS and channel limits, processing capacity, busy/failure %, vendor-side hang-up, RTP echo; restored after a server restart
- End-to-end measurement through the PBX: call number in the trailing digits, routing delay, calls not reached, duplicates, failure location (PBX vs trunk)
- Desktop app (Electron) and web server edition (Docker); English and Turkish

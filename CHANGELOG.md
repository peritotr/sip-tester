# Changelog

## 0.2.0

- Built-in vendor runs several trunks (A–D), each on its own port with its own delays and limits, for testing failover between a primary and backup carriers
- End-to-end measurement per trunk: calls taken by each trunk, failovers (rejected on one trunk, taken on another), failover delay, calls rejected by every trunk, and the load at which failover started
- Report: trunk counters, failover column in the step table, failover line and onset marker on the load chart, one settings row per trunk; CSV adds failovers and calls per trunk
- A failover is no longer counted as a duplicate; a duplicate is a call the vendor took twice

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

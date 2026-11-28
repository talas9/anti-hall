# KB: Account Hot-Swap Gate Assessment (ToS, Keychain Safety, & Live Sessions)

Assessment and architectural decision record for Issue #268: "Account hot-swap for Claude/Codex from the Command Center".

> **Scope Note:** In accordance with the issue specification, all credential-writing or reading code is strictly blocked until these gates pass triage. This document records the design requirements, legal boundaries, and process state machine.

---

## 1. Gate 1: Terms of Service Analysis (Anthropic & OpenAI)

### 1.1 Anthropic Terms of Service
- **Circumvention Prohibition:** Anthropic's Commercial Terms and Consumer Terms of Service strictly forbid actions designed to evade, bypass, or circumvent rate limits, tier caps, or access quotas.
- **Automated Failover / Limit-Driven Swapping:** An automated mechanism that detects `rate_limit_exceeded` or approaching quota limits and silently rotates to an alternate API key or account is an explicit violation of ToS.
- **Legitimate Multi-Account Operation:** Operators frequently hold distinct organizational or billing identities (e.g., Personal Work vs. Corporate Client Work). Manually selecting which identity context is active for a work session is legally distinct from abusive rate-limit pooling.
- **Decision for Gate 1:** **Automated limit-driven rotation is rejected.** Only **manual, operator-initiated account switching** shall be supported in the Command Center.

### 1.2 OpenAI Terms of Use
- **Multi-Account Policies:** OpenAI Service Terms prohibit maintaining multiple accounts to manipulate or circumvent service tier limits.
- **Organizational Switching:** Selecting between legitimate, distinct workspace profiles via operator intent is compliant; programmatic pools rotating across 429 responses are prohibited.
- **Decision:** Align with Anthropic rule — manual profile selection only.

---

## 2. Gate 2: Credential Safety & Keychain Architecture

### 2.1 OS Keychain Storage
Tokens must never be stored in plain files, environment variables, logs, telemetry, or broadcast over the local Command Center WebSocket mesh.

- **macOS:** Stored using Keychain Services API (`security` / OS Keychain), using service namespace `anti-hall.credentials.<provider>.<account_id>`.
- **Linux:** Stored using the Freedesktop Secret Service API over D-Bus (`org.freedesktop.secrets`).
- **Windows:** Stored using Windows Credential Manager / DPAPI.

### 2.2 Atomic Credential Swapper
When an operator triggers a manual switch in the Command Center:
1. The backend retrieves the session token from the OS Keychain.
2. The provider's target config file (e.g. `~/.claude.json` or Codex configuration) is updated using an atomic write pattern:
   - Existing configuration is backed up to `.credentials.bak`.
   - New configuration is written to `.credentials.tmp.<pid>`.
   - `fs.renameSync` atomically swaps `.credentials.tmp.<pid>` into place.
3. Plaintext tokens are zeroed from memory immediately after the atomic write.

---

## 3. Gate 3: Live Session Management & Process Boundaries

### 3.1 In-Flight State Invalidation
Both Claude Code and OpenAI Codex CLI cache authorization tokens in process memory for the duration of a session. Changing credential files on disk while a tool call or prompt stream is executing causes mid-stream `401 Unauthorized` or token state confusion.

### 3.2 State Machine

```
      [Operator Requests Switch]
                  │
          Is Devswarm Busy?
         /                 \
     (No)                   (Yes)
      │                       │
      │              Display Warning in UI:
      │         "Active turn in progress. Interrupt?"
      │              /                 \
      │          [Cancel]            [Confirm]
      │             │                   │
      │        Abort Switch       Send SIGTERM to CLI
      │                                 │
      │                         Wait for Graceful Exit
      │                                 │
      └───────────┬─────────────────────┘
                  │
      [Execute Atomic Swap]
                  │
        [Restart CLI Session]
                  │
           [Status: Ready]
```

1. **IDLE:** If no session is running, the atomic swap executes immediately.
2. **BUSY:** If an active prompt turn, streaming response, or tool execution is in flight:
   - The Command Center displays a blocking prompt: *"Session is actively executing. Interrupt current turn to switch accounts?"*
   - On confirmation, `SIGTERM` is dispatched to the active CLI process, allowing up to 5 seconds for subagent shutdown.
   - The atomic swap executes, and the session reinitializes with the new identity.

---

## 4. Summary & Recommendation

1. **Gate 1:** Passed via strict policy — manual operator switching only; no automated limit evading.
2. **Gate 2:** Passed via OS Keychain architecture with atomic swap and zero-leakage invariants.
3. **Gate 3:** Passed via defined IDLE/BUSY lifecycle state machine with graceful CLI process restarts.

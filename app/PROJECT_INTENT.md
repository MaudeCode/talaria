# Talaria — Project Intent

This file is for fast orientation only. `PROJECT_SPEC.md` remains the source of truth for product scope, API behavior, build phases, dependencies, and open decisions.

Talaria is a native iPhone control surface for a self-hosted Hermes AI agent stack. The phone is the control plane and review surface; the macOS/server-side Hermes WebUI stack is the execution plane.

## Mental Model

- Start or continue Hermes sessions from iOS.
- Watch streaming agent work without using the desktop browser UI.
- Steer, stop, inspect, and recover work while away from the Mac.
- Keep authentication, navigation, composer controls, attachments, and offline read-only cache feeling native.
- Avoid dangerous write/admin surfaces until the mobile UX is explicit and safe.

## Boundaries

- Native SwiftUI app, not a webview wrapper.
- iOS client only; do not move server responsibilities into this repo.
- Existing Hermes WebUI API only; never invent endpoint paths or JSON shapes.
- Tolerant decoding over brittle model purity; upstream JSON can drift.
- Server owns execution. The app owns mobile interaction quality.

## Product Feel

The intended feel is dense, calm, operator-grade, and mobile-native. Prefer scan-friendly screens, compact controls, clear status, safe confirmations, and direct recovery paths over marketing-style UI.

## Fresh-Session Reading

Follow `AGENTS.md` and read only the `PROJECT_SPEC.md` sections relevant to the selected task. Read this file only when product intent or tradeoffs are unclear.

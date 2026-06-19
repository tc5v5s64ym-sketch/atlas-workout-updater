# Atlas Governance Spine

This file defines how Atlas's planning documents relate. It is a map of roles, not content. It exists so every idea has one correct home and no important decision lives only in chat.

## The hierarchy

```
Dream
  ↓
Vision
  ↓
Constitution
  ↓
Roadmap
  ↓
Backlog
```

Each layer serves the one above it. A Roadmap step exists to advance the Vision; the Vision exists to reach the Dream. The Constitution is the set of rules none of the layers below it may break in the pursuit.

## The layers

**Dream** — The destination. Why Atlas exists at all, years out. Changes rarely. Not a plan; the direction every other layer is checked against. Lives in `docs/ATLAS_PRODUCT_VISION.md` → "The Dream".

**Vision** — The product we build to reach the Dream. What Atlas actually becomes — its shape, its pillars, the experience. The Vision answers "what are we building," the Dream answers "toward what end." Lives in `docs/ATLAS_PRODUCT_VISION.md` and `docs/CONSTITUTION.md`.

**Constitution** — The laws we will not break while pursuing the Dream and Vision. Inviolable: the trust contract, no blind writes, the engine owns the numbers and AI only words them, the owner approves. A guardrail, not a destination. If anything below it conflicts with the Constitution, the Constitution wins. Lives in `docs/CONSTITUTION.md` and `docs/INVARIANTS.md`.

**Roadmap** — The current leg of the journey. What is actively being built now, as one ordered execution queue. Everything here must trace upward to the Vision and stay inside the Constitution. Lives in `docs/ACTIVE_ROADMAP.md`.

**Backlog** — The single source of truth for all open and deferred work. The widest and most concrete layer. Everything not yet done lives here so nothing is lost. Lives in `BACKLOG.md`.

## The curator rule

Every significant idea discovered through discussion must be intentionally assigned a primary home in Dream, Vision, Constitution, Roadmap, or Backlog. No important project decision should exist only in chat history.

The owner is not responsible for filing. When the owner brainstorms, the agent places the idea in the correct layer and states where it went.

# Desktop adapter seam - not implemented

`WebSurface` currently supplies `observe`, `resolve`, `act`, `check`, `read`, and
masked evidence capture. A Windows UIA or macOS accessibility implementation would
need stable window/control scopes and the same typed action/predicate semantics.
Its policy must independently restrict applications and irreversible actions;
the web network guard is not a desktop safety mechanism. A matching normalized
tree alone does not prove replay compatibility. Pixel-only/Citrix surfaces need a
separate grounding and verification design. No desktop execution is claimed here.

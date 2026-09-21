# Separate application, Agent, packages, and workflow data

YuanpuAgent stores product configuration under `~/.yuanpu/app`, Pi-compatible runtime data under `~/.yuanpu/agent`, installed capability packages under `~/.yuanpu/packages`, and workflow state under `~/.yuanpu/workflows`. We chose explicit roots instead of treating `~/.yuanpu` itself as Pi's Agent directory so Pi-compatible resources remain portable while application updates, marketplace rollbacks, and workflow retention can evolve independently.


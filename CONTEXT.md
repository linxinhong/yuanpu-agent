# YuanpuAgent

YuanpuAgent presents installable work capabilities as one simple product concept while preserving the runtime distinctions needed for safe loading and updates.

## Language

**技能**:
The user-facing unit that adds a coherent work capability. A skill may contain instructions, expert agents, workflows, executable extensions, or service connections.
_Avoid_: Plugin, Adapter, Extension in primary user interfaces

**能力包**:
The versioned, installable distribution unit behind a skill. It owns provenance, integrity, permissions, configuration, and one or more components.
_Avoid_: Plugin package

**组件**:
An internal part of a capability package, such as an instruction skill, expert agent, workflow, extension, prompt, theme, or connector.
_Avoid_: Presenting component kinds as separate marketplace products

**技能市场**:
The catalog through which users discover, install, update, and inspect skills from configured sources.
_Avoid_: Plugin registry

**本地技能**:
A user-authored skill discovered from the local Agent directory and not owned by the marketplace installer.
_Avoid_: Unmanaged plugin


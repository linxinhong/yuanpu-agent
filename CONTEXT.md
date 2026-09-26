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

**工作对话**:
围绕一项工作的独立会话。同一对话内可以连续交流，新建工作对话不继承其他工作对话或助理的记忆；其记录仍可供助理整理。
_Avoid_: 全局工作会话

**助理**:
综合已接入信息持续了解用户、自动整理工作，并通过子代理协作完成任务的个人代理。它拥有独立的会话、记忆与助理技能。桌面和已绑定消息渠道是它的入口，不是不同的助理身份。
_Avoid_: 工作对话的长期模式

**助理记忆**:
助理根据有来源的对话、资料与工作结果整理出的可修订知识，包括明确事实、偏好、目标与待核实的推断；它不同于原始聊天记录。
_Avoid_: 对话备份

**主动建议**:
助理根据记忆和时间条件生成、带有依据与行动理由的提议。生成建议不等于代替用户执行。
_Avoid_: 自动任务

**助理技能**:
围绕理解用户、整理记忆、梳理工作、跟进承诺和委派任务编写的专属技能；助理使用的专业能力由执行子代理提供。
_Avoid_: 助理加载的所有系统技能

**执行子代理**:
接受助理委派，在独立任务对话中使用所选专业技能，返回结果与证据的执行者。助理负责汇总结果并维护自己的记忆。
_Avoid_: 助理身份的副本

**工作台账**:
助理持续整理的项目进展、承诺、待跟进事项与下一步。记录区分用户已确认的安排、实际执行状态与助理建议。
_Avoid_: 自动生成的用户承诺

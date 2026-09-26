# TASK-009 Memory

冻结 Python MCP 的首次启动不能沿用普通进程的 3 秒总发现预算：PyInstaller 冷启动会在工具实际可用前被 CapabilityRegistry 截断，并被聚合搜索表现为“未发现”。Yuanpu Runtime 对该受管 source 使用 15 秒初始化、20 秒总发现的有限预算。已初始化连接若在工具列表请求阶段超时或异常，必须失效 client/transport 并终止进程组，下一次连接仍受既有重启预算约束。

根级 `pnpm smoke:native` 必须自行准备冻结 Python 制品，不能依赖工作树里残留的 `dist-artifact`。CI 若已显式构建/验证制品，可调用 package-level runtime smoke 避免重复构建。

# omega_flow — JSON 微运行时 v2

新增一个 MCP 工具，组合调用已有 omega 实现；旧工具名称、参数和文本响应保持不变。
运行时 `omega-flow.mjs`，等待器 `omega-flow-wait.mjs`，注册于 `server.mjs`。无需 npm 依赖。

## 最小示例：输入 → 读取 → 验收 → 输出

```json
{
  "vars": { "file": "/absolute/path/example.txt", "token": "READY" },
  "steps": [
    { "id": "read", "tool": "omega_read", "args": { "path": { "$ref": "vars.file" } } },
    { "id": "check", "assert": { "left": { "$ref": "steps.read.text" }, "op": "contains", "right": { "$ref": "vars.token" } } }
  ],
  "outputs": { "evidence": { "$ref": "steps.read.text" } },
  "waitMs": 20000
}
```

返回 JSON：`id/state/done/total/results/outputs`。`state` 是 `running/success/failed/cancelled`；
参数错误在执行前返回 `rejected`。`done` 为已尝试执行的步骤数量，不包括条件跳过或停止后的步骤。
`success` 只证明所写的步骤/断言通过；发起 batch 并不证明 batch 已完成。

## 数据和控制流

- 每步必须有唯一 `id`，且恰好选择一种：`tool + args`、`set`、`assert`、`awaitBatch`。
- `vars` 是只读输入；`set` 把 JSON 值存为 `steps.<id>.data`，不隐式覆盖其它变量。
- `{"$ref":"vars.foo"}` 与 `{"$ref":"steps.read.text"}` 保留数值/布尔/数组/对象类型。
  路径使用点分隔，可用数组索引；不支持包含点的键。缺失引用是错误，不插入空字符串。
- `{"$literal":{"$ref":"just text"}}` 可转义引用对象。普通字符串不进行 `${...}` 插值。
- 工具结果统一为 `steps.<id>.status/isError/text`，有结构化数据时另有 `.data`。
  `parseJson:true` 明确把工具返回文本解析为 `.data`，失败即该步失败。
- 每步可带 `when:{left,op,right}`；断言使用同样结构。运算符：
  `eq/ne/contains/gt/gte/lt/lte`。布尔和数字不做隐式类型转换。
- 默认失败停止；`stopOnError:false` 会继续独立步骤，但整条 flow 仍返回失败。
- 不支持循环、递归 flow、并行、任意代码、隐式重试或自动回滚。
- 全计划先做结构、工具白名单与前向引用检查。工具具体参数由原工具校验；
  后续运行时失败不会撤销前面已经完成的操作。

## batch → 有界等待终态

需先由管理员在 MCP 进程环境显式设置 `OMEGA_FLOW_ALLOW_EFFECTS=1`，然后重启。

```json
{
  "allowEffects": ["omega_batch"],
  "steps": [
    { "id": "launch", "tool": "omega_batch", "args": { "steps": [
      { "label": "syntax", "command_line": "node --check server.mjs && python3 -c 'print(\"SYNTAX_OK\")'", "cwd": "/absolute/mcp", "timeout": "30s", "expect": { "contains": ["SYNTAX_OK"] } }
    ] } },
    { "id": "wait", "awaitBatch": {
      "id": { "$ref": "steps.launch.data.jobId" }, "timeoutMs": 120000
    } },
    { "id": "accept", "assert": { "left": { "$ref": "steps.wait.data.state" }, "op": "eq", "right": "success" } }
  ],
  "outputs": { "batchId": { "$ref": "steps.launch.data.jobId" } }
}
```

`awaitBatch` 只查询同一个现有 batch，不重新启动命令。默认总期限 120 秒，允许 1..600000 毫秒；
一次内部状态等待最多 5 秒。如果状态立即返回 running，仍至少间隔约 1 秒才再次查询。
只有 `success` 通过；`failed/partial/cancelled` 均失败。超时返回 `batch_timeout` 并保留原 jobId。
等待器是只读操作，查询已有 job 不需要开启效果权限；上例的 **launch** 才需要双开。

`waitMs` 控制本次 RPC 等待返回多久，`awaitBatch.timeoutMs` 控制该步骤的总等待期限，二者独立。
当 RPC 返回 running 时，使用 `action:status` 查询原 flow ID。超时后查询原 batch ID，勿重新提交命令。
取消 flow 会在当前状态查询返回后停止继续查询（通常不超过约 5 秒）；底层 batch 继续运行。
取消优先于同时返回的成功状态；截止时间之后才收到的成功仍算本次等待超时，并在诊断中保留
已观察到的 state。**flow 等待超时或取消不等于底层 batch 失败**，应通过保留的 jobId 查询。
旧版 `omega_batch_status + parseJson + assert` 写法仍兼容；它只进行一次状态查询。

## 失败诊断和可继续查询的 ID

- 默认响应新增 `handles:{"launch":{"jobId":"job-..."},"edit":{"batchId":"edit-..."}}`。
  后续失败、输出超限或取消时仍保留，不需要 `verbose:true`；dry-run 无实际撤销点。
- `active` 表示当前执行步骤，等待时包含 jobId，并在取得状态后包含 polls/state。
- `failure:{stepId,code,error}` 指向首个失败；每个失败步骤仍保留自身诊断。
  输出表达式失败没有 stepId。`outputs` 仍只在成功时生成。
- 常见 code：`assertion_failed`、`condition_type`、`resolve`、`parse_json`、`tool_error`、
  `tool_exception`、`invalid_tool_result`、`result_limit`、`batch_timeout`、`batch_failed`。
  非法请求返回 `rejected/invalid_request`；原字符串 `error` 字段继续保留。
- 断言失败含有界的左右值类型/JSON 预览；解析失败保留工具名与原文前 240 字符。
  预览可能截断，只作诊断，不能代替完整证据。batch 失败时由原 jobId 查询其详细报告。
- `status/cancel` 拒绝未知字段；`args/parseJson` 仅用于 tool 步骤，避免静默忽略拼写错误。

## 编辑与撤销

`omega_edit` 内部结果新增 `.data:{batchId,dryRun,applied}`；dry-run 的 `batchId` 为 null。
`omega_batch` 内部结果新增 `.data:{jobId}`。现有 MCP 调用仍返回原文本；结构化字段供 flow 使用。

开启服务端效果权限且请求包含 `allowEffects:["omega_edit","omega_undo"]` 后，
后续步骤可以把 `{"$ref":"steps.edit.data.batchId"}` 直接传给 `omega_undo.args.batchId`。
原编辑唯一匹配、断言、两阶段提交和 undo 语义照常执行。

## 权限边界

默认仅允许 read/grep/guard_check/health/quota/sqlite、batch_status、artifact_read/search。
编辑、撤销、batch 和 batch_cancel 必须同时满足服务端环境开关和请求 allowEffects 清单。
`db_query`、`vfs_local_write`、`run_process` 不在白名单内。

**MCP host 只对 `omega_flow` 这个入口授权，不会重新对内部工具逐项授权。**
这是聚合权限，不是自动继承调用者的 `edit:deny`。如果开启效果工具，必须限制哪些 agent
可以调用 omega_flow；只读 subagent 不应获准调用已启用效果权限的入口。
请求里的 allowEffects 只是显式意图，不替代 host 授权。
原工具内建的命令 guard/SQL 只读/编辑断言仍保留，但不能把 guard 当作完整 shell 沙箱。

## 异步、资源限制与加载

- `{"action":"status","id":"flow-...","waitMs":20000,"verbose":true}` 查询。
- `{"action":"cancel","id":"flow-..."}` 请求取消，仅阻止后续步骤，不杀当前工具。
  **取消不释放名额** —— 已取消的 flow 仍占用名额直到 30 分钟过期。
- 默认等待 20 秒、最多 50 秒；到时返回 running 和真实 ID。进程内顺序执行，等待不忙轮询。
- 每条最多 32 步；输入、正常保留数据和单次变量展开预算分别为 256 KB，另含有界诊断元数据；JSON 深度最多 24。
  超限可能发生在底层操作完成后，应查看实际文件或 batch，不能当作自动撤销。
- 最多保留 16 条 flow，完成后 30 分钟过期。结果仅在 MCP 进程内存；重启后无法恢复。
  **因为 cancel 不释放名额，开满 16 条后到过期前所有新 flow 都会被拒**
  （`flow capacity reached; completed jobs expire after 30 minutes`）。
  需要放宽就在 MCP 进程环境设 `OMEGA_FLOW_MAX_JOBS=<1..1024 的整数>` 后重启；
  留空或设成非法值（0、负数、小数、非数字、超范围）一律回落到 16，**不会静默取消上限**。
  默认返回摘要；`verbose:true` 返回保留的完整步骤结果。工具自己截断的文本不会被恢复。
- 修改已在磁盘，**重启 OpenCode/MCP 后才会出现工具**。先确保没有运行中的 flow/batch。
  本轮未默认打开效果权限，也没有自动重启当前 MCP。

验收：`node --test mcp/omega-flow.test.mjs mcp/omega-flow-wait.test.mjs mcp/omega-flow.round2.test.mjs`，
并运行原 `node mcp/tools-ext.test.mjs`。测试使用临时文件、模拟执行器及独立 stdio MCP 子进程；
第二轮 wire 测试会在隔离子进程显式启用效果权限，执行一个打印固定标记的真实命令并验收 stdout。
这不改变当前 MCP 的效果权限，也不能证明当前会话已加载新版工具。

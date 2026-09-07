// Owner mandate, 2026-09-07: do not execute the legacy simulated test suites.
// This guard deliberately fails rather than reporting an unperformed test as passed.
process.stderr.write(
  "模拟/回放测试已按项目要求停用。需要验证时，仅使用小样本真实模型，走真实 Agent、工具与持久化链路。\n" +
  "本命令未执行任何测试。请阅读 AGENTS.md 和 docs/TESTING.md；不要绕过此规则直接运行旧测试套件。\n",
);
process.exitCode = 1;

import { createInterface } from 'node:readline';
const mode = process.argv[2] || 'success';
const protocol = process.argv[3] || 'codex';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (protocol !== 'codex') {
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else if (mode === 'malformed') { console.log('broken json'); }
  else if (mode === 'missing-terminal') { send({ type: 'init', session_id: 'session-test', model: 'test-model' }); }
  else if (protocol === 'antigravity') {
    send({ event: 'init', conversation_id: 'conversation-test', init: { cwd: process.cwd(), permission_mode: mode === 'unsafe-policy' ? 'always-proceed' : 'request-review', model: 'test-model' } });
    send({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' } });
    send({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: mode === 'denied' ? { error: { type: 'permission', message: 'permission denied' } } : {} } });
    send({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'héllo' } });
    send({ event: 'result', result: { conversation_id: 'conversation-test', status: mode === 'quota' ? 'ERROR' : 'SUCCESS', error: mode === 'quota' ? 'quota exhausted' : undefined, response: 'héllo', usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, total_tokens: 12 } } });
  }
  else if (protocol === 'claude') {
    send({ type: 'system', subtype: 'init', session_id: 'session-test', model: 'test-model' });
    send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'héllo' } } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false }] } });
    send({ type: 'result', subtype: mode === 'quota' ? 'error_during_execution' : 'success', is_error: mode === 'quota', errors: mode === 'quota' ? ["You've hit your limit · resets 3pm"] : [], result: 'héllo', session_id: 'session-test', usage: { input_tokens: 10, output_tokens: 2 } });
  } else {
    send({ type: 'init', session_id: 'session-test', model: 'test-model' });
    send({ type: 'tool_use', tool_id: 'tool-1', tool_name: 'read_file' });
    send({ type: 'message', role: 'assistant', content: 'héllo', delta: true });
    send({ type: 'tool_result', tool_id: 'tool-1', status: 'success' });
    send({ type: 'result', status: mode === 'quota' ? 'error' : 'success', error: mode === 'quota' ? { message: 'quota exhausted' } : undefined, stats: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  }
} else {
  let thread = 'native-session', config, turn = 'turn-test', pendingApproval;
  const finish = (status = 'completed', error) => send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status, error } } });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    const response = (result) => send({ id: request.id, result });
    if (!request.method && request.id === pendingApproval) { send({ method: 'item/agentMessage/delta', params: { threadId: thread, delta: request.result.decision } }); finish(); return; }
    switch (request.method) {
      case 'initialize': if (mode !== 'hang-probe') response({ userAgent: 'fixture', platformOs: process.platform }); break;
      case 'account/read': response({ account: { type: 'chatgpt' } }); break;
      case 'model/list': response({ data: [{ model: 'test-model', displayName: 'Test', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: null }); break;
      case 'thread/start': case 'thread/resume': {
        config = request.params;
        response({ thread: { id: thread }, model: config.model || 'test-model', cwd: config.cwd, approvalPolicy: config.approvalPolicy, approvalsReviewer: config.approvalsReviewer, sandbox: { type: mode === 'unsafe-policy' ? 'dangerFullAccess' : config.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: false }, reasoningEffort: config.config.model_reasoning_effort || 'low' }); break;
      }
      case 'turn/start': {
        response({ turn: { id: turn } });
        send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
        if (mode === 'hang') return;
        if (mode === 'disconnect') { process.exit(0); return; }
        if (mode === 'malformed') { console.log('bad json'); return; }
        if (mode.startsWith('approval')) {
          pendingApproval = 500;
          send({ id: pendingApproval, method: mode === 'approval-grant' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, command: 'test command', cwd: mode === 'approval-escape' ? '/outside' : config.cwd, grantRoot: mode === 'approval-grant' ? config.cwd : undefined, networkApprovalContext: mode === 'approval-network' ? { host: 'example.com' } : undefined } }); return;
        }
        send({ method: 'item/started', params: { threadId: thread, item: { type: 'commandExecution', id: 'tool-1', command: 'read test', status: 'inProgress' } } });
        send({ method: 'item/agentMessage/delta', params: { threadId: thread, delta: 'héllo' } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } } });
        finish(mode === 'quota' ? 'failed' : mode === 'interrupted' ? 'interrupted' : 'completed', mode === 'quota' ? { message: 'quota exhausted' } : undefined); break;
      }
      case 'turn/interrupt': response({}); finish('interrupted'); break;
    }
  });
}

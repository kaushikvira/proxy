/**
 * Live Session Dashboard — self-contained HTML/JS/CSS for the /sessions viewer.
 * Connects to /api/live/events via SSE and renders session trees in real time.
 */

export function getLiveSessionHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live Sessions — Proxy Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: #0d1117; color: #c9d1d9; line-height: 1.5; overflow: hidden;
    height: 100vh; display: flex; flex-direction: column;
  }
  a { color: #58a6ff; text-decoration: none; }

  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; border-bottom: 1px solid #21262d; background: #161b22;
    flex-shrink: 0;
  }
  .header h1 { font-size: 16px; font-weight: 600; }
  .status-dot {
    width: 10px; height: 10px; border-radius: 50%; display: inline-block;
    margin-right: 8px; background: #f85149; vertical-align: middle;
  }
  .status-dot.connected { background: #3fb950; }
  .status-label { font-size: 13px; color: #8b949e; }

  /* Session tabs */
  .tabs {
    display: flex; gap: 4px; padding: 8px 20px; border-bottom: 1px solid #21262d;
    background: #161b22; overflow-x: auto; flex-shrink: 0;
  }
  .tab {
    padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
    border: 1px solid #30363d; background: #0d1117; color: #8b949e;
    display: flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .tab:hover { border-color: #58a6ff; color: #c9d1d9; }
  .tab.active { border-color: #58a6ff; color: #c9d1d9; background: #161b22; }
  .tab-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #484f58;
    flex-shrink: 0;
  }
  .tab-dot.active {
    background: #3fb950;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(63,185,80,0.5); }
    50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(63,185,80,0); }
  }

  /* Main content area */
  .content {
    flex: 1; overflow-y: auto; padding: 16px 20px;
  }

  /* Request card */
  .request-card {
    border: 1px solid #21262d; border-radius: 6px; margin-bottom: 10px;
    background: #161b22; overflow: hidden;
  }
  .request-header {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    font-size: 13px; cursor: pointer; flex-wrap: wrap;
  }
  .request-header:hover { background: #1c2128; }
  .req-time { color: #8b949e; font-size: 12px; flex-shrink: 0; }
  .req-model {
    background: #1f6feb33; color: #58a6ff; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600; flex-shrink: 0;
  }
  .req-message { color: #c9d1d9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .req-cost { color: #8b949e; font-size: 12px; flex-shrink: 0; }
  .req-tokens { color: #8b949e; font-size: 11px; flex-shrink: 0; }
  .req-error { color: #f85149; }

  /* Thinking block */
  .thinking-block {
    margin: 8px 14px; padding: 10px 14px; border-radius: 6px;
    background: #1c1c2e; border-left: 3px solid #2d2d44;
    max-height: 400px; overflow-y: auto;
  }
  .thinking-block.streaming { border-left-color: #8957e5; }
  .thinking-label {
    font-size: 11px; font-weight: 700; color: #8957e5; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 4px;
  }
  .thinking-text {
    font-size: 13px; color: #b392f0; white-space: pre-wrap; word-break: break-word;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  }

  /* Response block */
  .response-block {
    margin: 8px 14px; padding: 10px 14px; border-radius: 6px;
    background: #0d1117; border: 1px solid #21262d;
    max-height: 300px; overflow-y: auto;
  }
  .response-text {
    font-size: 13px; white-space: pre-wrap; word-break: break-word;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  }

  /* Tool call */
  .tool-call {
    margin: 4px 14px; padding: 8px 12px; border-radius: 4px;
    background: #0d1117; border: 1px solid #21262d; font-size: 12px;
  }
  .tool-name {
    color: #d2a8ff; font-weight: 600; margin-right: 8px;
  }
  .tool-input { color: #8b949e; font-family: monospace; font-size: 11px; }

  /* Subagent group */
  .subagent-group {
    margin-left: 20px; border-left: 2px solid #1f6feb; padding-left: 12px;
    margin-bottom: 10px;
  }
  .subagent-label {
    font-size: 12px; color: #58a6ff; font-weight: 600; margin: 8px 0 4px 0;
  }

  /* Session summary */
  .session-summary {
    font-size: 12px; color: #8b949e; padding: 4px 0 8px 0;
    display: flex; gap: 14px;
  }

  /* Expandable sections */
  .expandable { display: none; padding-bottom: 10px; }
  .expandable.open { display: block; }

  /* Empty state */
  .empty-state {
    text-align: center; padding: 60px 20px; color: #484f58;
  }
  .empty-state h2 { font-size: 18px; margin-bottom: 8px; color: #8b949e; }

  /* Streaming indicator */
  .streaming-indicator {
    display: inline-block; width: 6px; height: 14px;
    background: #8957e5; margin-left: 4px; vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="header">
  <h1>Live Sessions</h1>
  <div>
    <span class="status-dot" id="statusDot"></span>
    <span class="status-label" id="statusLabel">Connecting...</span>
  </div>
</div>
<div class="tabs" id="tabs"></div>
<div class="content" id="content">
  <div class="empty-state">
    <h2>No sessions yet</h2>
    <p>Waiting for proxy requests...</p>
  </div>
</div>

<script>
(function() {
  // State
  let sessions = {};         // sessionId -> SessionNode
  let activeSessionId = null;
  let userScrolledUp = false;
  let streamingRequests = {}; // traceId -> { sessionId, thinking, text, toolCalls }

  // XSS-safe escaping
  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function formatCost(c) {
    if (!c || c === 0) return '';
    if (c < 0.01) return '$' + c.toFixed(4);
    return '$' + c.toFixed(3);
  }

  function formatTokens(tin, tout, thinking) {
    var parts = [];
    if (tin) parts.push(tin.toLocaleString() + ' in');
    if (tout) parts.push(tout.toLocaleString() + ' out');
    if (thinking) parts.push(thinking.toLocaleString() + ' think');
    return parts.join(' / ');
  }

  function formatTime(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleTimeString();
    } catch(e) { return ''; }
  }

  // --- Rendering ---

  function renderTabs() {
    var tabsEl = document.getElementById('tabs');
    var html = '';
    var ids = Object.keys(sessions).sort(function(a, b) {
      var sa = sessions[a], sb = sessions[b];
      if (sa.isActive !== sb.isActive) return sa.isActive ? -1 : 1;
      return (sb.lastSeenAt || 0) - (sa.lastSeenAt || 0);
    });
    for (var i = 0; i < ids.length; i++) {
      var s = sessions[ids[i]];
      var isActive = activeSessionId === ids[i];
      var dotClass = s.isActive ? 'tab-dot active' : 'tab-dot';
      html += '<div class="tab' + (isActive ? ' active' : '') + '" data-sid="' + esc(ids[i]) + '">'
        + '<span class="' + dotClass + '"></span>'
        + esc(truncate(ids[i], 16))
        + ' <span style="color:#8b949e;font-size:11px">(' + (s.totalRequests || 0) + ' reqs, ' + formatCost(s.totalCost) + ')</span>'
        + '</div>';
    }
    tabsEl.innerHTML = html;

    // Attach click handlers
    var tabEls = tabsEl.querySelectorAll('.tab');
    for (var j = 0; j < tabEls.length; j++) {
      tabEls[j].addEventListener('click', function() {
        activeSessionId = this.getAttribute('data-sid');
        renderTabs();
        renderContent();
      });
    }
  }

  function renderRequestCard(req, isStreaming) {
    var id = req.id || '';
    var expanded = isStreaming;
    var html = '<div class="request-card" id="card-' + esc(id) + '">';
    html += '<div class="request-header" onclick="toggleExpand(this)">';
    html += '<span class="req-time">' + esc(formatTime(req.timestamp)) + '</span>';
    html += '<span class="req-model">' + esc(req.model || req.routedModel || '?') + '</span>';
    html += '<span class="req-message">' + esc(truncate(req.userMessage, 80)) + '</span>';
    if (req.costUsd) html += '<span class="req-cost">' + esc(formatCost(req.costUsd)) + '</span>';
    var tokStr = formatTokens(req.tokensIn, req.tokensOut, req.thinkingTokens);
    if (tokStr) html += '<span class="req-tokens">' + esc(tokStr) + '</span>';
    if (req.error) html += '<span class="req-error"> ERR</span>';
    html += '</div>';

    // Thinking block — always visible if present
    var thinkingText = req.thinkingContent || '';
    if (thinkingText || isStreaming) {
      var streamClass = isStreaming ? ' streaming' : '';
      html += '<div class="thinking-block' + streamClass + '" id="thinking-' + esc(id) + '">';
      html += '<div class="thinking-label">Thinking</div>';
      html += '<div class="thinking-text" id="thinking-text-' + esc(id) + '">' + esc(thinkingText);
      if (isStreaming) html += '<span class="streaming-indicator"></span>';
      html += '</div></div>';
    }

    // Expandable: response + tools
    html += '<div class="expandable' + (expanded ? ' open' : '') + '" id="expand-' + esc(id) + '">';
    if (req.responseText) {
      html += '<div class="response-block"><div class="response-text" id="response-text-' + esc(id) + '">' + esc(req.responseText) + '</div></div>';
    }
    if (req.toolCalls && req.toolCalls.length) {
      for (var t = 0; t < req.toolCalls.length; t++) {
        var tc = req.toolCalls[t];
        html += '<div class="tool-call"><span class="tool-name">' + esc(tc.name) + '</span>'
          + '<span class="tool-input">' + esc(truncate(tc.inputPreview || '', 120)) + '</span></div>';
      }
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderContent() {
    var contentEl = document.getElementById('content');
    if (!activeSessionId || !sessions[activeSessionId]) {
      contentEl.innerHTML = '<div class="empty-state"><h2>No sessions yet</h2><p>Waiting for proxy requests...</p></div>';
      return;
    }
    var sess = sessions[activeSessionId];
    var html = '';

    // Session summary
    html += '<div class="session-summary">';
    html += '<span>Session: ' + esc(truncate(sess.sessionId, 24)) + '</span>';
    html += '<span>Requests: ' + (sess.totalRequests || 0) + '</span>';
    html += '<span>Cost: ' + formatCost(sess.totalCost) + '</span>';
    html += '</div>';

    // Main agent requests
    if (sess.requests && sess.requests.length) {
      for (var i = 0; i < sess.requests.length; i++) {
        html += renderRequestCard(sess.requests[i], false);
      }
    }

    // Streaming requests for this session (not yet finalized)
    var streamIds = Object.keys(streamingRequests);
    for (var si = 0; si < streamIds.length; si++) {
      var sr = streamingRequests[streamIds[si]];
      if (sr.sessionId === activeSessionId && !sr.parentTraceId) {
        html += renderRequestCard({
          id: streamIds[si],
          timestamp: sr.timestamp || new Date().toISOString(),
          model: sr.model || '',
          userMessage: sr.userMessage || '',
          thinkingContent: sr.thinking || '',
          responseText: sr.text || '',
          toolCalls: sr.toolCalls || [],
          tokensIn: 0, tokensOut: 0, thinkingTokens: 0, costUsd: 0
        }, true);
      }
    }

    // Subagent groups
    if (sess.children && sess.children.length) {
      for (var c = 0; c < sess.children.length; c++) {
        var child = sess.children[c];
        html += '<div class="subagent-group">';
        html += '<div class="subagent-label">' + esc(child.agentLabel || 'Subagent') + '</div>';
        if (child.requests) {
          for (var r = 0; r < child.requests.length; r++) {
            html += renderRequestCard(child.requests[r], false);
          }
        }
        // Streaming subagent requests
        for (var si2 = 0; si2 < streamIds.length; si2++) {
          var sr2 = streamingRequests[streamIds[si2]];
          if (sr2.sessionId === activeSessionId && sr2.parentTraceId && sr2.agentFingerprint === child.agentFingerprint) {
            html += renderRequestCard({
              id: streamIds[si2],
              timestamp: sr2.timestamp || new Date().toISOString(),
              model: sr2.model || '',
              userMessage: sr2.userMessage || '',
              thinkingContent: sr2.thinking || '',
              responseText: sr2.text || '',
              toolCalls: sr2.toolCalls || [],
              tokensIn: 0, tokensOut: 0, thinkingTokens: 0, costUsd: 0
            }, true);
          }
        }
        html += '</div>';
      }
    }

    contentEl.innerHTML = html;
    maybeAutoScroll();
  }

  // Toggle expand for response/tool sections
  window.toggleExpand = function(headerEl) {
    var card = headerEl.parentElement;
    var expandable = card.querySelector('.expandable');
    if (expandable) expandable.classList.toggle('open');
  };

  // --- Auto-scroll ---
  function setupAutoScroll() {
    var contentEl = document.getElementById('content');
    contentEl.addEventListener('scroll', function() {
      var el = this;
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp = !atBottom;
    });
  }

  function maybeAutoScroll() {
    if (userScrolledUp) return;
    var contentEl = document.getElementById('content');
    contentEl.scrollTop = contentEl.scrollHeight;
  }

  // --- In-place streaming updates (avoid full re-render) ---
  function updateStreamingThinking(traceId, text) {
    var el = document.getElementById('thinking-text-' + traceId);
    if (el) {
      el.innerHTML = esc(text) + '<span class="streaming-indicator"></span>';
      maybeAutoScroll();
      return true;
    }
    return false;
  }

  function updateStreamingResponse(traceId, text) {
    var el = document.getElementById('response-text-' + traceId);
    if (el) {
      el.textContent = text;
      maybeAutoScroll();
      return true;
    }
    return false;
  }

  // --- SSE Connection ---
  function connectSSE() {
    var evtSource = new EventSource('/api/live/events');

    evtSource.addEventListener('connected', function(e) {
      document.getElementById('statusDot').classList.add('connected');
      document.getElementById('statusLabel').textContent = 'Connected';
    });

    evtSource.addEventListener('heartbeat', function(e) {
      // Keep-alive, no action needed
    });

    evtSource.addEventListener('stream.start', function(e) {
      var data = JSON.parse(e.data);
      var traceId = data.traceId || data.id;
      streamingRequests[traceId] = {
        sessionId: data.sessionId || '',
        model: data.model || '',
        userMessage: data.userMessage || '',
        parentTraceId: data.parentTraceId || null,
        agentFingerprint: data.agentFingerprint || '',
        timestamp: data.timestamp || new Date().toISOString(),
        thinking: '',
        text: '',
        toolCalls: []
      };
      // Auto-select session if none selected
      if (!activeSessionId && data.sessionId) {
        activeSessionId = data.sessionId;
      }
      renderTabs();
      renderContent();
    });

    evtSource.addEventListener('stream.thinking', function(e) {
      var data = JSON.parse(e.data);
      var traceId = data.traceId || data.id;
      var sr = streamingRequests[traceId];
      if (sr) {
        sr.thinking += (data.text || data.content || '');
        if (!updateStreamingThinking(traceId, sr.thinking)) {
          renderContent();
        }
      }
    });

    evtSource.addEventListener('stream.text', function(e) {
      var data = JSON.parse(e.data);
      var traceId = data.traceId || data.id;
      var sr = streamingRequests[traceId];
      if (sr) {
        sr.text += (data.text || data.content || '');
        if (!updateStreamingResponse(traceId, sr.text)) {
          renderContent();
        }
      }
    });

    evtSource.addEventListener('stream.tool_call', function(e) {
      var data = JSON.parse(e.data);
      var traceId = data.traceId || data.id;
      var sr = streamingRequests[traceId];
      if (sr) {
        sr.toolCalls.push({ name: data.name || '?', inputPreview: data.inputPreview || data.input || '' });
        renderContent();
      }
    });

    evtSource.addEventListener('stream.end', function(e) {
      var data = JSON.parse(e.data);
      var traceId = data.traceId || data.id;
      delete streamingRequests[traceId];
      // session.updated or request.captured will provide the final data
    });

    evtSource.addEventListener('request.captured', function(e) {
      var data = JSON.parse(e.data);
      var sid = data.sessionId;
      if (!sessions[sid]) {
        sessions[sid] = {
          sessionId: sid, agentFingerprint: '', agentLabel: 'Main Agent',
          parentTraceId: null, children: [], requests: [],
          isActive: true, totalCost: 0, totalRequests: 0, lastSeenAt: Date.now()
        };
      }
      var sess = sessions[sid];
      if (data.parentTraceId) {
        var child = null;
        for (var i = 0; i < sess.children.length; i++) {
          if (sess.children[i].agentFingerprint === data.agentFingerprint) {
            child = sess.children[i]; break;
          }
        }
        if (!child) {
          child = {
            sessionId: sid, agentFingerprint: data.agentFingerprint || '',
            agentLabel: 'Subagent ' + (sess.children.length + 1),
            parentTraceId: data.parentTraceId, children: [], requests: [],
            isActive: true, totalCost: 0, totalRequests: 0, lastSeenAt: Date.now()
          };
          sess.children.push(child);
        }
        child.requests.push(data);
        child.totalCost += (data.costUsd || 0);
        child.totalRequests++;
        child.lastSeenAt = Date.now();
      } else {
        sess.requests.push(data);
      }
      sess.totalCost += (data.costUsd || 0);
      sess.totalRequests++;
      sess.lastSeenAt = Date.now();
      sess.isActive = true;

      if (!activeSessionId) activeSessionId = sid;
      renderTabs();
      renderContent();
    });

    evtSource.addEventListener('session.updated', function(e) {
      var data = JSON.parse(e.data);
      if (data.sessionId && data.tree) {
        sessions[data.sessionId] = data.tree;
        renderTabs();
        if (activeSessionId === data.sessionId) renderContent();
      }
    });

    evtSource.onerror = function() {
      document.getElementById('statusDot').classList.remove('connected');
      document.getElementById('statusLabel').textContent = 'Disconnected — reconnecting...';
    };

    evtSource.onopen = function() {
      document.getElementById('statusDot').classList.add('connected');
      document.getElementById('statusLabel').textContent = 'Connected';
    };
  }

  // --- Load existing sessions ---
  function loadSessions() {
    fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(data) {
      var list = Array.isArray(data) ? data : (data && Array.isArray(data.sessions) ? data.sessions : []);
      if (list.length > 0) {
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (s.sessionId) sessions[s.sessionId] = s;
        }
        if (!activeSessionId && list[0].sessionId) {
          activeSessionId = list[0].sessionId;
        }
        renderTabs();
        renderContent();
      }
    }).catch(function() {
      // Sessions API may not be ready yet
    });
  }

  // --- Init ---
  setupAutoScroll();
  loadSessions();
  connectSSE();
})();
</script>
</body>
</html>`;
}

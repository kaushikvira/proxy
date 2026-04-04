NODE     := node
CLI      := dist/cli.js
PID_FILE := .proxy.pid
PORT     := 4100

.DEFAULT_GOAL := help

.PHONY: help build start stop status restart service-install service-uninstall service-restart service-status logs test-token-rotation

## Show this help
help:
	@echo ""
	@echo "  Local LLM Proxy — available commands"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //' | while IFS= read -r line; do \
		target=$$(grep -m1 "^[a-z]" $(MAKEFILE_LIST) | head -1); true; done; \
	awk '/^## /{desc=$$0; sub(/^## /,"",desc); next} /^[a-zA-Z_-]+:/{printf "  \033[36m%-20s\033[0m %s\n", $$1, desc}' $(MAKEFILE_LIST)
	@echo ""

## Build TypeScript
build:
	npm run build

## Start proxy in the background
start: $(CLI)
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Proxy already running (PID $$(cat $(PID_FILE)))"; \
	else \
		$(NODE) $(CLI) & echo $$! > $(PID_FILE); \
		echo "Proxy started on port $(PORT) (PID $$(cat $(PID_FILE)))"; \
	fi

## Stop background proxy
stop:
	@if [ -f $(PID_FILE) ]; then \
		PID=$$(cat $(PID_FILE)); \
		if kill -0 $$PID 2>/dev/null; then \
			kill $$PID && echo "Proxy stopped (PID $$PID)"; \
		else \
			echo "Proxy not running"; \
		fi; \
		rm -f $(PID_FILE); \
	else \
		echo "No PID file — proxy may not be running"; \
	fi

## Restart background proxy
restart: stop start

## Check if proxy is running
status:
	@$(NODE) $(CLI) service status 2>/dev/null || \
	([ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null \
		&& echo "Proxy running (PID $$(cat $(PID_FILE)))" \
		|| echo "Proxy not running")

## Install as a system service (starts on machine load, restarts on crash)
## macOS: launchd  |  Linux: systemd
service-install: $(CLI)
	$(NODE) $(CLI) service install

## Restart the launchd service (macOS)
service-restart:
	@launchctl kickstart -k gui/$$(id -u)/com.kv-local-proxy.proxy 2>/dev/null \
		|| (launchctl stop com.kv-local-proxy.proxy && launchctl start com.kv-local-proxy.proxy) \
		&& echo "Service restarted"

## Remove the system service
service-uninstall:
	$(NODE) $(CLI) service uninstall

## Show system service status
service-status:
	$(NODE) $(CLI) service status

## Tail proxy logs (macOS launchd path)
logs:
	@tail -f ~/Library/Logs/relayplane-proxy.log 2>/dev/null \
		|| journalctl -u relayplane-proxy -f 2>/dev/null \
		|| echo "No log file found"

## Force a token rotation on next request (corrupts stored hash, then restarts service)
test-token-rotation:
	@python3 -c "\
import json, os; \
f = os.path.expanduser('~/.kv-local-proxy/token-rotations.json'); \
d = json.load(open(f)); \
assert d.get('current'), 'No current token on disk — send a request through the proxy first'; \
d['current']['tokenHash'] = '0000000000000000'; \
open(f, 'w').write(json.dumps(d, indent=2)); \
print('  Token hash corrupted — rotation will trigger on next request') \
" && $(MAKE) --no-print-directory service-restart

$(CLI):
	@echo "dist/ not found — run 'make build' first"; exit 1

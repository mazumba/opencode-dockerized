-include .env
export

USER_UID ?= $(shell id -u)
USER_GID ?= $(shell id -g)

opencode-down: ## stop and remove opencode container
	docker/compose-with-plugins.sh down --remove-orphans

opencode-build: opencode-down ## build opencode container
	docker/compose-with-plugins.sh build --no-cache

opencode-build-plugins: opencode-down ## build with plugins from .env (PLUGINS=<name>,<name>)
	@bash docker/build-plugins.sh

opencode-run: opencode-down ## run opencode container
	docker/compose-with-plugins.sh up -d --wait opencode
	@echo '                                    ▄     '
	@echo '   █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█'
	@echo '   █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀'
	@echo '   ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'
	@echo '                                          '
	@echo '   Local access:     http://localhost:4096 (user: opencode, password: OPENCODE_SERVER_PASSWORD from .env)'

kanban-poller-run: ## start the kanban poller (needs the kanban plugin in PLUGINS)
	docker/compose-with-plugins.sh --profile kanban-poller up -d kanban-poller

kanban-poller-logs: ## follow the kanban poller logs
	docker/compose-with-plugins.sh --profile kanban-poller logs -f kanban-poller

kanban-poller-down: ## stop and remove the kanban poller
	docker/compose-with-plugins.sh --profile kanban-poller stop kanban-poller
	docker/compose-with-plugins.sh --profile kanban-poller rm -f kanban-poller

kanban-poller-once: ## run a single kanban poller pass, performing real actions
	docker/compose-with-plugins.sh --profile kanban-poller run --rm kanban-poller --once

kanban-poller-dry-run: ## run a single kanban poller pass without writes or agent runs
	docker/compose-with-plugins.sh --profile kanban-poller run --rm kanban-poller --once --dry-run

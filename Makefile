USER_UID ?= $(shell id -u)
USER_GID ?= $(shell id -g)
export USER_UID USER_GID

opencode-build:
	mkdir -p .opencode/config && mkdir -p .opencode/share
	docker compose build --no-cache

opencode-run: ## run opencode container
	mkdir -p .opencode/config && mkdir -p .opencode/share
	docker compose up -d --wait --remove-orphans opencode
	@echo '                                    ▄     '
	@echo '   █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█'
	@echo '   █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀'
	@echo '   ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'
	@echo '                                          '
	@echo '   Local access:     http://localhost:4096'

opencode-down:
	docker compose down --remove-orphans

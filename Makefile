USER_UID ?= $(shell id -u)
USER_GID ?= $(shell id -g)
export USER_UID USER_GID

opencode-down: ## stop and remove opencode container
	docker compose down --remove-orphans

opencode-build: opencode-down ## build opencode container
	docker compose build --no-cache

opencode-run: opencode-down ## run opencode container
	docker compose up -d --wait opencode
	@echo '                                    ▄     '
	@echo '   █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█'
	@echo '   █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀'
	@echo '   ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'
	@echo '                                          '
	@echo '   Local access:     http://localhost:4096'

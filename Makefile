.PHONY: test
test:
	npm test

.PHONY: format
format:
	npm run lint
	npm run format:check

.PHONY: install
install:
	npm install

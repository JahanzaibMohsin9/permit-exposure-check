# AI usage

This project was built with **Claude Code** (Anthropic) as a pair programmer. A human developer directed the work, reviewed the code and made the decisions.

| Area | AI-generated | Human |
|---|---|---|
| Idea selection | Three rounds of independent AI reviews scored the candidate ideas against the competition and the chain's real capabilities. | Final choice of what to build. |
| Contracts (`PermitExposureRegistry.sol`, tests) | First drafts and the test cases. | Review, and verification against the live testnet. |
| Web app | Adapted from the official `create-qorechain-dapp` viem-wagmi template. | Review and manual testing with QoreX. |
| Facts about the chain | Each one checked against the live testnet with `eth_call` and fork tests, not taken from memory. | |

Workflow: the AI drafts code, Foundry tests run on every change, live-testnet checks confirm assumptions, and a human reviews before committing.

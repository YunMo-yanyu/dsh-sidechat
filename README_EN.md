# Sidechat for DeepSeek Harness

[简体中文](README.md)

Temporary side conversations for DeepSeek Harness, using the same interface as the main chat. Ask questions about the current task, inspect files, and understand code while the main conversation continues its work.

## Features

- **Native interface**: shared model selection, reasoning controls, composer, waiting states, reasoning display, and streaming answers.
- **Contextual questions**: a text snapshot of the main conversation provides initial context. Select transcript text and choose “Ask” to include a quotation.
- **Independent model**: starts with the main chat's model and reasoning effort, then supports independent changes.
- **Read-only answers**: reads text files, lists directories, and searches content. File modifications, command execution, and task delegation are blocked. Discuss proposed changes here; execute them in the main conversation.
- **Temporary records**: follow-up questions stay in one conversation. Closing its tab stops generation and clears its local records and draft.
- **Keep your place**: collapsing the sidebar, switching sidebar tabs, or navigating to another main conversation preserves the temporary chat.

## Installation

Current version: **1.3.1**. Verified with the Web interface of DeepSeek Harness **0.2.0-rc.2**, on Node.js **20 or later**.

1. Download `dsh-sidechat-1.3.1.tgz` from [Releases](https://github.com/YunMo-yanyu/dsh-sidechat/releases/latest).
2. Install it into the Web profile:

   ```sh
   dsh plugin --profile web add /path/to/dsh-sidechat-1.3.1.tgz
   ```

3. Restart Harness and refresh the browser.

The package name is `dsh-sidechat`. Back up the Web profile configuration before upgrading. Load the package once per profile.

## Usage

1. Open “Temporary chat” in the main conversation, or select transcript text and choose “Ask”.
2. Enter your question. To inspect files, provide a path or describe what to find.
3. Continue the discussion or change the side chat's model. The main chat retains its own model and draft.
4. Close the temporary-chat tab when finished. Opening it again creates a blank conversation.

The side chat displays “Read-only answers” and offers no permission switching. Requests to perform changes are directed to the main conversation.

## File and conversation behavior

- Relative paths use the main chat's working directory at opening time; absolute paths are supported.
- UTF-8 text files are limited to 2 MiB each. Read up to 2000 lines per call and use subsequent windows to continue.
- Search uses literal strings and skips binary/oversized files and `.git`, `node_modules`, and `.dsh` directories. Bounded searches and outputs report truncation or skipped inputs.
- Main-chat context is an opening-time text snapshot. Later messages, images, and raw tool outputs are not automatically copied.
- Refreshing or leaving the page ends its temporary chats. Registered records left after an abnormal exit are cleaned up on the next server start.
- Local cleanup applies only to temporary chats created by this plugin and does not alter model providers' retention policies.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Tool execution restrictions and the read-only file policy constrain model actions. These controls do not provide operating-system isolation for trusted third-party plugin code running in the host process.

After upgrading Harness, verify the native embedding interfaces, read-only enforcement, and temporary JSONL cleanup interfaces. See [VALIDATION.md](VALIDATION.md). An example CI configuration is available at `.github/ci.example.yml`.

## License

[MIT](LICENSE)

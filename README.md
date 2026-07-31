# Carrier Pigeon

Carrier Pigeon is a semi-agentic tool to utilize a web chat interface for AI coding without having an API token.

The name is an allusion to [RFC 2549: IP Over Avian Carriers](https://www.rfc-editor.org/info/rfc2549/). It's basically a slow way to do what we can do with an API token.

## How to use

* Open the "Carrier Pigeon for AI" extension in the sidebar.

* Write the prompt with mentions of the filenames. For example

    ```
    Why am I not getting logs from the command in @my_pkg/main.go ?
    ```

    Or

    ```
    Update @my_pkg/api_client.go update method to make PATCH requests with only changed fields.
    ```

* Click copy context, context will be copied to your clipboard

* Paste it in web chat UI (such as Gemini) and get the answer.
    * Tip: If the context too large to paste, save it to a file using `pbpaste` and then upload.

* Copy the whole answer using copy button in the bottom of the answer.

* Paste back in the VSCode / Cursor by with `Paste` button.
    * The prompt instructs the model to included edits and tool calls in JSON as fenced code blocks. This is the same strategy used by libraries like `instructor` when the models didn't have tool calls yet (2 years ago).
    * You need to approve any tool calls (read files, run command, edits).
    * If the agent response contains diffs in the specified format, they will be auto applied. Look out for `Copy errors` below the pasted text - few times the diff may not apply.

## Development / Installation
I haven't published this extension. You can install it with some NPM nonsense instead.

Install Node 24. Eg: on RH-derived Linux systems

```bash
sudo dnf module enable nodejs:24
sudo dnf install nodejs
node --version # ensure 24.x
```

Create extension package

```bash
npm install -g @vscode/vsce
vsce package ## may need to add npm dir to $PATH before running this
```

* This produces a .vsix extension.
* Install it by Cmd+Shift+P -> "Extensions: Install from VSIX".
* Open "Carrier Pigeon for AI" from the activity bar (same bar which shows files, search, extensions).

## Disclaimer
Fully vibe coded. Initially used cursor. Last few edits were produced by `pigeon` itself so it has become good enough now.

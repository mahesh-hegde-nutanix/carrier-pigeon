## Pigeon

Pigeon is a semi-agentic (hehe) tool to utilize a web chat interface for AI coding without having an API token.

The name is an allusion to [RFC 2549: IP Over Avian Carriers](https://www.rfc-editor.org/info/rfc2549/). It's basically a slow way to do what we can do with an API token.

## How to use

* Open the extension in the sidebar.

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
    * If the context too large to paste, save it to a file using `pbpaste` and then upload.

* Copy the whole answer using copy button in the bottom of the answer.

* Paste back in the VSCode / Cursor by with `Paste` button.

* If the response contains any tool calls, then you will be prompted whether to run them.

* **Note: Select AGENT MODE instead of ASK MODE for the chat to make changes in your files**.

## Development / Installation stuff

Install Node 24. Eg: on RH-derived Linux systems

```bash
sudo dnf module enable nodejs:24
sudo dnf install nodejs
node --version # ensure 24.x
```

Create extension package

```bash
npm install -g @vscode/vsce

```
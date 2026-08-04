# Carrier Pigeon

Use LLM web UIs (such as Gemini) to understand code and make changes without requiring an API token.

The idea is to instruct the AI to include its "tool calls" (file edits, reads and shell commands) in a specified format into the markdown response itself, so that the user can mechanically copy-paste back and forth between a web-based chat UI and a VSCode extension, __functioning like a "manual" API for a coding agent__.

In practice, this is not as bad as it sounds. With decent context engineering and right tools, this turns out to be a pretty convenient way to use web-based LLMs with existing code.

This workflow is designed such that you can continue the conversation from the chat UI if you have no extra context to add. Let's say LLM produced a diff, which you didn't apply because you wanted to refine it.

```
I did not apply this change. Can you ensure the max size of requested_ids is at most 1024, or raise a ValidationError otherwise?
```

This means you don't need to come back to the VSCode extension to copy a trivial message, unless you have to run a tool or add extra context.

The name "Carrier Pigeon" is an pun alluding to [RFC 1149: IP Over Avian Carriers](https://en.wikipedia.org/wiki/IP_over_Avian_Carriers).

## How to use

* Open the "Carrier Pigeon for AI" extension in the sidebar.

* Write the prompt with mentions of the filenames using `@`. For example

    ```
    Why am I not getting logs from the command in @my_pkg/main.go ?
    ```

    Or

    ```
    Update @my_pkg/api_client.go update method to make PATCH requests with only changed fields.
    ```

* Click copy context; context & instructions will be copied to your clipboard.

* Paste it in the web chat UI (such as Gemini) and get the answer.

* At this point the answer can be two things
    * A human readable answer to something you asked. In this case continue the conversation from the web UI itself.
    * A tool call in JSON code block, or a SEARCH-REPLACE diff
        * copy it back to the extension using the `PASTE` button
        * The extension runs the tool or file edit.
        * If it was a tool (run_cmd or read_files), you will be asked to confirm and the result will get copied to your clipboard. Paste the tool result back into the UI and continue the conversation.
        * If it was an edit, the edit will be applied to the files.

## Development / Installation
I haven't published this extension.

You can install it with NPM.

Firstly, clone this repo.

Then install Node 24. Eg: on RH-derived Linux systems

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

This produces a .vsix extension. Install it by Cmd+Shift+P -> "Extensions: Install from VSIX". After installation, open "Carrier Pigeon for AI" from the activity bar (usually on the left or right, same bar which shows files, search, extensions etc...).

## Disclaimer
Fully vibe coded (with oversight - the idea and architectural decisions are mine).

Initially used cursor. Last few edits were produced by `pigeon` itself so it has become good enough now.

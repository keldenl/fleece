const os = require("os");
const vscode = require("vscode");
const io = require("socket.io-client");

// Get the user's platform (e.g. "win32", "darwin", "linux")
const platform = os.platform();

// Activate the extension
function activate(context) {
  // server variables
  const terminalName = "fleece-dalai-terminal";
  let existingTerminal;
  let serverProcessId;

  let prompt = "";
  let promptNewLines = 0;
  let token = "";
  let generating = false;
  let newLinesInARow = 0;

  // Utils to help parse token output
  const escapeNewLine = (arg) =>
    platform.toLowerCase() === "win32"
      ? arg.replaceAll(/\n/g, "\\n").replaceAll(/\r/g, "\\r")
      : arg;
  const escapeDoubleQuotes = (arg) =>
    platform.toLowerCase() === "win32"
      ? arg.replaceAll(/"/g, '`"')
      : arg.replaceAll(/"/g, '\\"');

  const sanitizeText = (text) => escapeNewLine(escapeDoubleQuotes(text));

  // Socket setup
  const socket = io("ws://localhost:3000");
  socket.on("connect", () => {
    console.log("Socket.io Client Connected");

    socket.on("disconnect", () => {
      console.log("Socket.io Client Disconnected");
    });

    socket.on("result", async ({ request, response }) => {
      generating = true;
      // Filter out common errors that the terminal may spit back
      if (
        response.includes(`repeat_penalty = `) ||
        typeof response !== "string"
      ) {
        return;
      }
      token += response;
      token = sanitizeText(token).trim();

      if (token.length <= prompt.trim().length + promptNewLines) {
        // +1 for the \n in the end
        return;
      } else if (response == "\n\n<end>" || response == "end{code}") {
        token = "";
        prompt = "";
        promptNewLines = 0;
        generating = false;
        vscode.commands.executeCommand("fleece.stopFleece");
        vscode.window.showInformationMessage("Done!");
        return;
      }

      // avoid having too many new lines in a row
      const isNewlineResponse = response.trim().length == 0;
      if (isNewlineResponse) {
        newLinesInARow++;
        if (newLinesInARow > 1) {
          return;
        }
      } else {
        newLinesInARow = 0;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const position = editor.selection.active;

      // delete \end{code} if existing
      if (
        token.substring(prompt.length - 1, token.length).includes("end{code}")
      ) {
        const rangeToDelete = new vscode.Range(
          position.line,
          Math.max(0, position.character - 9),
          position.line,
          position.character
        );
        editor.edit((editBuilder) => editBuilder.delete(rangeToDelete));
        vscode.commands.executeCommand("fleece.stopFleece");
        vscode.window.showInformationMessage("Done!");
        return;
      }

      // Otherwise, print the response at the cursor position
      editor.edit((editBuilder) => editBuilder.insert(position, response));
    });

    // Handle socket.io error events
    socket.on("connect_error", (error) => {
      console.error("Socket.io Connect Error: " + error.toString());
      if (error.toString() === "Error: xhr poll error") {
        vscode.window.showErrorMessage(
          "Can't reach Dalai server. Restart local server?"
        );
      } else {
        vscode.window.showErrorMessage(
          "Socket.io Connect Error: " + error.toString()
        );
      }
    });

    socket.on("error", (error) => {
      console.error("Socket.io Error: " + error.toString());
      vscode.window.showErrorMessage("Socket.io Error: " + error.toString());
    });
  });

  // UTILS
  const prependFileName = (input) => {
    const editor = vscode.window.activeTextEditor;
    // const fileName = editor.document.fileName;
    // const relativePath = vscode.workspace.asRelativePath(fileName);
    const language = editor.document.languageId;

    return `Given the following comment:\n'${input.trim()}'\nWrite a concise implementation that follows best practices and common programming patterns. The implementation should focus on the task at hand while avoiding unnecessary complexity or verbosity. Use ${language} unless otherwise specified in the comment. Begin implementation below:\n\\begin{code}\n`;
    // chatgpt assisted - this is pretty good
    // return `Given the following comment: ${input.trim()}\nGenerate code implementation that fulfills the requirements stated in the comment. The implementation should be concise and easy to understand, while following best practices and common programming patterns. Avoid unnecessary complexity or verbosity. Please note that we have limited information about the task at hand beyond the comment provided.\n\\begin{code}\n`
    // original prompt i created
    // return `The following is an senior software developer's code. It uses short, concise comments and specifically only implements the following comment: '${input.trim()}'\n\\begin{code}\n`;
  };

  const getEditorLineOrSelection = () => {
    const editor = vscode.window.activeTextEditor;
    const selection = editor.selection;
    if (!selection.isEmpty) {
      return editor.document.getText(selection);
    } else {
      const lineNumber = selection.active.line;
      const line = editor.document.lineAt(lineNumber);
      return line.text;
    }
  };

  const goToNextLine = () => {
    const editor = vscode.window.activeTextEditor;
    const selection = editor.selection;

    const line = selection.isEmpty
      ? selection.active.line + 1 // No selection, go to next line
      : selection.end.line + 1; // Selection, go to line after selection
    vscode.commands.executeCommand("editor.action.insertLineAfter");
    editor.selection = new vscode.Selection(line, 0, line, 0);
  };

  const submitDalaiRequest = (prompt, config) => {
    const defaultConfig = {
      // temp: 0.1,
      // // n_predict: 256,
      // top_p: 1,
      // // repeat_penalty: 1
      // repeat_last_n: 5,

      // chatgpt assisted configs
      n_predict: 96,
      top_k: 40,
      top_p: 0.9,
      repeat_last_n: 2,
      repeat_penalty: 1.5,
      temp: 0.3,

      // these below 2 need to be adjusted for machine by machine basis
      model: "alpaca.7B",
      threads: 4,
    };
    token = ""; // reset the response token
    prompt = sanitizeText(prompt);
    promptNewLines = (prompt.match(/\n/g) || []).length;
    socket.emit("request", {
      ...defaultConfig,
      ...config,
      prompt,
    });
  };

  const showThinkingMessage = () => {
    const msg = vscode.window.showInformationMessage("Fleece is thinking...", {
      title: "Stop autocomplete",
      action: "stopAutocomplete",
    });
    if (msg) {
      msg.then((selection) => {
        if (selection?.action === "stopAutocomplete") {
          vscode.commands.executeCommand("fleece.stopFleece");
        }
      });
    }
  };

  const setMaybeExistingTerminal = () => {
    existingTerminal = vscode.window.terminals.find(
      (t) => t.name === terminalName
    );

    if (existingTerminal) {
      existingTerminal.show();
      if (!serverProcessId) {
        existingTerminal.processId.then((pid) => {
          serverProcessId = pid;
        });
      }
    }
    return existingTerminal;
  };

  // COMMANDS
  // START SERVER
  let disposibleStartServer = vscode.commands.registerCommand(
    "fleece.startDalai",
    () => {
      const startServerCommand = `npx dalai serve`;
      const stopServerCommand = "\x03"; // Send Ctrl+C to stop server
      setMaybeExistingTerminal();

      if (existingTerminal) {
        existingTerminal.sendText(stopServerCommand);
        existingTerminal.sendText(startServerCommand);
      } else {
        existingTerminal = vscode.window.createTerminal(terminalName);
        existingTerminal.processId.then((pid) => {
          serverProcessId = pid;
          // Wait for a brief moment to give the terminal time to start up
          setTimeout(() => {
            existingTerminal.sendText(stopServerCommand);
            existingTerminal.sendText(startServerCommand);
            vscode.window.onDidCloseTerminal((closedTerminal) => {
              if (closedTerminal.name === existingTerminal.name) {
                // Handle error
                if (closedTerminal.exitStatus?.code !== 0) {
                  vscode.window.showInformationMessage(
                    `Dalai server crashed unexpectedly (Code: ${code})`
                  );
                } else {
                  vscode.window.showInformationMessage(
                    `Dalai server closed successfully`
                  );
                }
              }
            });
          }, 1000);
        });

        existingTerminal.show();
      }
    }
  );

  // STOP COMMAND
  let disposableStop = vscode.commands.registerCommand(
    "fleece.stopFleece",
    async function () {
      if (generating) {
        socket.emit("request", { prompt: "/stop" });
      }
    }
  );

  // AUTOCOMPLETE COMMAND
  let disposable = vscode.commands.registerCommand(
    "fleece.commentToCode",
    async function () {
      setMaybeExistingTerminal();
      if (!serverProcessId) {
        await vscode.commands.executeCommand("fleece.startDalai");
      }
      prompt = prependFileName(getEditorLineOrSelection());
      submitDalaiRequest(prompt);
      goToNextLine();
      showThinkingMessage();
    }
  );

  // Add the commands to the extension context
  context.subscriptions.push(disposibleStartServer);
  context.subscriptions.push(disposable);
  context.subscriptions.push(disposableStop);
}

exports.activate = activate;

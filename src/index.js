const os = require("os");
const vscode = require("vscode");
const io = require("socket.io-client");

// Get the user's platform (e.g. "win32", "darwin", "linux")
const platform = os.platform();

// Activate the extension
function activate(context) {
  console.log("ACTIVATED/");
  let prompt = "";
  let token = "";

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
      if (typeof response !== "string") {
        return;
      }
      token += sanitizeText(response).trim();
      token = sanitizeText(token);
      if (token.length <= prompt.length) {
        console.log("Still repeating request");
        return;
      } else if (response == "\n\n<end>" || response == "end{code}") {
        vscode.window.showInformationMessage("Done!");
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // Print the response at the cursor position
      const position = editor.selection.active;
      editor.edit((editBuilder) => editBuilder.insert(position, response));
    });

    // Handle socket.io error events
    socket.on("connect_error", (error) => {
      console.error("Socket.io Connect Error: " + error.toString());
      vscode.window.showErrorMessage(
        "Socket.io Connect Error: " + error.toString()
      );
    });

    socket.on("error", (error) => {
      console.error("Socket.io Error: " + error.toString());
      vscode.window.showErrorMessage("Socket.io Error: " + error.toString());
    });
  });

  // UTILS
  const prependFileName = (input) => {
    const editor = vscode.window.activeTextEditor;
    const fileName = editor.document.fileName;
    return `The following code is the file ${fileName}:\n${input}\n`;
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
      temp: 0,
      n_predict: 64,
      top_p: 1,
      repeat_penalty: 0,
      // these below 2 need to be adjusted for machine by machine basis
      model: "alpaca.7B",
      threads: 4,
    };
    token = ""; // reset the repsonse token
    socket.emit("request", {
      ...defaultConfig,
      ...config,
      prompt: sanitizeText(prompt),
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

  // COMMANDS
  // STOP COMMAND
  let disposableStop = vscode.commands.registerCommand(
    "fleece.stopFleece",
    async function () {
      socket.emit("request", { prompt: "/stop" });
    }
  );

  // AUTOCOMPLETE COMMAND
  let disposable = vscode.commands.registerCommand(
    "fleece.autocompleteNextLine",
    async function () {
      prompt = prependFileName(getEditorLineOrSelection());
      submitDalaiRequest(prompt);
      goToNextLine();
      showThinkingMessage();
    }
  );
  // Add the command to the extension context
  context.subscriptions.push(disposable);
  context.subscriptions.push(disposableStop);
}

exports.activate = activate;

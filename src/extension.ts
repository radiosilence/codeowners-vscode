import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import { execSync } from "child_process";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

const GITHUB_REPO = "radiosilence/codeowners-lsp";
const BINARY_NAME = "codeowners-lsp";

interface GithubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

interface HoverContents {
  value: string;
}

interface HoverResult {
  contents: string | HoverContents | Array<string | HoverContents>;
}

function getPlatformInfo(): { os: string; arch: string; ext: string } | null {
  const platform = os.platform();
  const arch = os.arch();

  let osName: string;
  let archName: string;
  let ext = "";

  switch (platform) {
    case "darwin":
      osName = "apple-darwin";
      break;
    case "linux":
      osName = "unknown-linux-gnu";
      break;
    case "win32":
      osName = "pc-windows-msvc";
      ext = ".exe";
      break;
    default:
      return null;
  }

  switch (arch) {
    case "arm64":
      archName = "aarch64";
      break;
    case "x64":
      archName = "x86_64";
      break;
    default:
      return null;
  }

  return { os: osName, arch: archName, ext };
}

function getAssetName(version: string): string | null {
  const platform = getPlatformInfo();
  if (!platform) return null;

  return `${BINARY_NAME}-${version}-${platform.arch}-${platform.os}${platform.ext}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "codeowners-vscode",
          Accept: "application/vnd.github.v3+json",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          fetchJson<T>(response.headers.location).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${String(response.statusCode)}`));
          return;
        }

        let data = "";
        response.on("data", (chunk: Buffer) => (data += chunk.toString()));
        response.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }
    );
    request.on("error", reject);
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(
      url,
      {
        headers: { "User-Agent": "codeowners-vscode" },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${String(response.statusCode)}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }
    );
    request.on("error", (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function getLatestRelease(): Promise<GithubRelease> {
  return fetchJson<GithubRelease>(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  );
}

function getStoragePath(context: vscode.ExtensionContext): string {
  return context.globalStorageUri.fsPath;
}

function getBinaryPath(context: vscode.ExtensionContext): string {
  const platform = getPlatformInfo();
  const ext = platform?.ext ?? "";
  return path.join(getStoragePath(context), `${BINARY_NAME}${ext}`);
}

function getVersionPath(context: vscode.ExtensionContext): string {
  return path.join(getStoragePath(context), "version");
}

function findBinaryInPath(): string | null {
  try {
    const cmd =
      os.platform() === "win32" ? `where ${BINARY_NAME}` : `which ${BINARY_NAME}`;
    const result = execSync(cmd, { encoding: "utf8" }).trim();
    const firstResult = result.split("\n")[0];
    if (firstResult && fs.existsSync(firstResult)) {
      return firstResult;
    }
  } catch {
    // Not found in PATH
  }
  return null;
}

async function ensureBinary(
  context: vscode.ExtensionContext
): Promise<string | null> {
  const config = vscode.workspace.getConfiguration("codeowners");
  const customPath = config.get<string>("serverPath");

  // Custom path takes precedence
  if (customPath?.trim()) {
    const expandedPath = customPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expandedPath)) {
      return expandedPath;
    }
    void vscode.window.showErrorMessage(
      `CODEOWNERS: Custom server path not found: ${customPath}`
    );
    return null;
  }

  // Check PATH
  const pathBinary = findBinaryInPath();
  if (pathBinary) {
    return pathBinary;
  }

  // Download from GitHub releases
  const storagePath = getStoragePath(context);
  const binaryPath = getBinaryPath(context);
  const versionPath = getVersionPath(context);

  // Ensure storage directory exists
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  // Check if we have a cached version
  let currentVersion: string | null = null;
  if (fs.existsSync(versionPath) && fs.existsSync(binaryPath)) {
    currentVersion = fs.readFileSync(versionPath, "utf8").trim();
  }

  // Fetch latest release
  let release: GithubRelease;
  try {
    release = await getLatestRelease();
  } catch (err) {
    if (currentVersion && fs.existsSync(binaryPath)) {
      // Use cached version if we can't fetch
      return binaryPath;
    }
    void vscode.window.showErrorMessage(
      `CODEOWNERS: Failed to fetch latest release: ${String(err)}`
    );
    return null;
  }

  const latestVersion = release.tag_name.replace(/^v/, "");

  // Check if we need to download
  if (currentVersion === latestVersion && fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  // Find matching asset
  const assetName = getAssetName(latestVersion);
  if (!assetName) {
    void vscode.window.showErrorMessage(
      `CODEOWNERS: Unsupported platform: ${os.platform()} ${os.arch()}`
    );
    return null;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    void vscode.window.showErrorMessage(
      `CODEOWNERS: No binary found for ${assetName}`
    );
    return null;
  }

  // Download with progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CODEOWNERS: Downloading language server v${latestVersion}...`,
      cancellable: false,
    },
    async () => {
      await downloadFile(asset.browser_download_url, binaryPath);

      // Make executable on Unix
      if (os.platform() !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
      }

      // Save version
      fs.writeFileSync(versionPath, latestVersion);
    }
  );

  return binaryPath;
}

function getServerOptions(binaryPath: string): ServerOptions {
  return {
    run: {
      command: binaryPath,
      transport: TransportKind.stdio,
    },
    debug: {
      command: binaryPath,
      transport: TransportKind.stdio,
    },
  };
}

function getLspSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("codeowners");

  const settings: Record<string, unknown> = {};

  // Basic settings
  const codePath = config.get<string>("path");
  if (codePath) settings.path = codePath;

  const individual = config.get<string>("individual");
  if (individual) settings.individual = individual;

  const team = config.get<string>("team");
  if (team) settings.team = team;

  const githubToken = config.get<string>("githubToken");
  if (githubToken) settings.github_token = githubToken;

  const validateOwners = config.get<boolean>("validateOwners");
  if (validateOwners !== undefined) settings.validate_owners = validateOwners;

  // Diagnostic settings
  const diagnostics: Record<string, string> = {};

  const diagMap: Record<string, string> = {
    invalidPattern: "invalid-pattern",
    invalidOwner: "invalid-owner",
    patternNoMatch: "pattern-no-match",
    duplicateOwner: "duplicate-owner",
    shadowedRule: "shadowed-rule",
    noOwners: "no-owners",
    unownedFiles: "unowned-files",
    githubOwnerNotFound: "github-owner-not-found",
    fileNotOwned: "file-not-owned",
  };

  for (const [key, lspKey] of Object.entries(diagMap)) {
    const value = config.get<string>(`diagnostics.${key}`);
    if (value) {
      diagnostics[lspKey] = value;
    }
  }

  if (Object.keys(diagnostics).length > 0) {
    settings.diagnostics = diagnostics;
  }

  return settings;
}

function getClientOptions(): LanguageClientOptions {
  return {
    documentSelector: [
      { scheme: "file", language: "codeowners" },
      // Register for all common languages to get ownership hints
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "javascriptreact" },
      { scheme: "file", language: "python" },
      { scheme: "file", language: "rust" },
      { scheme: "file", language: "go" },
      { scheme: "file", language: "java" },
      { scheme: "file", language: "c" },
      { scheme: "file", language: "cpp" },
      { scheme: "file", language: "csharp" },
      { scheme: "file", language: "ruby" },
      { scheme: "file", language: "php" },
      { scheme: "file", language: "swift" },
      { scheme: "file", language: "kotlin" },
      { scheme: "file", language: "scala" },
      { scheme: "file", language: "haskell" },
      { scheme: "file", language: "ocaml" },
      { scheme: "file", language: "elixir" },
      { scheme: "file", language: "erlang" },
      { scheme: "file", language: "clojure" },
      { scheme: "file", language: "lua" },
      { scheme: "file", language: "perl" },
      { scheme: "file", language: "r" },
      { scheme: "file", language: "julia" },
      { scheme: "file", language: "dart" },
      { scheme: "file", language: "vue" },
      { scheme: "file", language: "svelte" },
      { scheme: "file", language: "astro" },
      { scheme: "file", language: "html" },
      { scheme: "file", language: "css" },
      { scheme: "file", language: "scss" },
      { scheme: "file", language: "less" },
      { scheme: "file", language: "json" },
      { scheme: "file", language: "jsonc" },
      { scheme: "file", language: "yaml" },
      { scheme: "file", language: "toml" },
      { scheme: "file", language: "xml" },
      { scheme: "file", language: "markdown" },
      { scheme: "file", language: "dockerfile" },
      { scheme: "file", language: "shellscript" },
      { scheme: "file", language: "powershell" },
      { scheme: "file", language: "sql" },
      { scheme: "file", language: "graphql" },
      { scheme: "file", language: "proto3" },
      { scheme: "file", language: "terraform" },
      { scheme: "file", language: "makefile" },
      { scheme: "file", language: "cmake" },
      { scheme: "file", language: "latex" },
      { scheme: "file", language: "plaintext" },
      // Catch-all for unknown files
      { scheme: "file", pattern: "**/*" },
    ],
    initializationOptions: getLspSettings(),
    synchronize: {
      configurationSection: "codeowners",
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/.codeowners-lsp.toml"),
        vscode.workspace.createFileSystemWatcher(
          "**/.codeowners-lsp.local.toml"
        ),
        vscode.workspace.createFileSystemWatcher("**/CODEOWNERS"),
        vscode.workspace.createFileSystemWatcher("**/.github/CODEOWNERS"),
        vscode.workspace.createFileSystemWatcher("**/docs/CODEOWNERS"),
      ],
    },
    middleware: {
      workspace: {
        configuration: async (params, token, next) => {
          const result = await next(params, token);
          // Inject our settings for each configuration request
          const settings = getLspSettings();
          if (Array.isArray(result)) {
            return result.map(() => settings);
          }
          return [settings] as unknown[];
        },
      },
    },
  };
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const binaryPath = await ensureBinary(context);
  if (!binaryPath) {
    return;
  }

  const serverOptions = getServerOptions(binaryPath);
  const clientOptions = getClientOptions();

  client = new LanguageClient(
    "codeowners",
    "CODEOWNERS Language Server",
    serverOptions,
    clientOptions
  );

  await client.start();
}

async function restartClient(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
  await startClient(context);
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("codeowners.restartServer", () =>
      restartClient(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeowners.showOwnership", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("No active editor");
        return;
      }

      if (!client) {
        void vscode.window.showErrorMessage("CODEOWNERS server not running");
        return;
      }

      // Trigger hover at line 1 to get ownership info
      const hoverResult = await client.sendRequest<HoverResult | null>("textDocument/hover", {
        textDocument: { uri: editor.document.uri.toString() },
        position: { line: 0, character: 0 },
      });

      if (hoverResult?.contents) {
        const contents = hoverResult.contents;
        let message: string;
        if (typeof contents === "string") {
          message = contents;
        } else if (Array.isArray(contents)) {
          message = contents
            .map((c) => (typeof c === "string" ? c : c.value))
            .join("\n");
        } else {
          message = contents.value;
        }
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showInformationMessage("No ownership information found");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeowners.goToRule", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("No active editor");
        return;
      }

      if (!client) {
        void vscode.window.showErrorMessage("CODEOWNERS server not running");
        return;
      }

      // Use go-to-definition to jump to CODEOWNERS rule
      await vscode.commands.executeCommand(
        "editor.action.goToDeclaration",
        editor.document.uri,
        editor.selection.active
      );
    })
  );

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeowners")) {
        // Notify client of configuration change
        if (client) {
          void client.sendNotification("workspace/didChangeConfiguration", {
            settings: getLspSettings(),
          });
        }
      }
    })
  );

  // Start the client
  await startClient(context);
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

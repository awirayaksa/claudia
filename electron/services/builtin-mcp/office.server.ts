import { spawn } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ============================================================================
// PowerShell Execution Helper
// ============================================================================

function runPowerShell(script: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error(`PowerShell script timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0 && stderr.trim()) {
        reject(new Error(`PowerShell exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to run PowerShell: ${err.message}`));
    });
  });
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      'Office Automation is only available on Windows. ' +
      'This server uses PowerShell COM automation to control Microsoft Office applications.'
    );
  }
}

// ============================================================================
// Server Factory
// ============================================================================

export function createOfficeServer(_config?: Record<string, unknown>): McpServer {
  const server = new McpServer(
    { name: 'Claudia Office Automation', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ---- office_available_apps ----
  server.tool(
    'office_available_apps',
    'Check which Microsoft Office applications are installed on this computer.',
    {},
    async () => {
      assertWindows();

      const script = `
        $apps = @('Word.Application', 'Excel.Application', 'PowerPoint.Application')
        $results = @()
        foreach ($app in $apps) {
          try {
            $type = [Type]::GetTypeFromProgID($app)
            if ($type) {
              $results += "$app: Installed"
            } else {
              $results += "$app: Not found"
            }
          } catch {
            $results += "$app: Not found"
          }
        }
        $results -join "\`n"
      `;

      const { stdout } = await runPowerShell(script);
      return { content: [{ type: 'text' as const, text: stdout || 'No Office applications detected.' }] };
    }
  );

  // ---- office_running_apps ----
  server.tool(
    'office_running_apps',
    'List currently running Microsoft Office processes.',
    {},
    async () => {
      assertWindows();

      const script = `
        $officeProcs = Get-Process -Name WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue
        if ($officeProcs) {
          $officeProcs | ForEach-Object {
            "$($_.ProcessName) (PID: $($_.Id)) - $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
          }
        } else {
          "No Office applications are currently running."
        }
      `;

      const { stdout } = await runPowerShell(script);
      return { content: [{ type: 'text' as const, text: stdout }] };
    }
  );

  // ---- office_launch ----
  server.tool(
    'office_launch',
    'Launch a Microsoft Office application, optionally opening a specific file.',
    {
      app: z.enum(['word', 'excel', 'powerpoint']).describe('Office application to launch'),
      file_path: z.string().optional().describe('Optional file path to open'),
      visible: z.boolean().optional().describe('Whether the app window should be visible (default: true)'),
    },
    async ({ app, file_path, visible }) => {
      assertWindows();

      const progIdMap: Record<string, string> = {
        word: 'Word.Application',
        excel: 'Excel.Application',
        powerpoint: 'PowerPoint.Application',
      };

      const progId = progIdMap[app];
      const isVisible = visible !== false;

      let script: string;
      if (file_path) {
        const escapedPath = file_path.replace(/'/g, "''");
        if (app === 'word') {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = $${isVisible}
            $doc = $app.Documents.Open('${escapedPath}')
            "Launched ${app} with file: ${escapedPath}"
          `;
        } else if (app === 'excel') {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = $${isVisible}
            $wb = $app.Workbooks.Open('${escapedPath}')
            "Launched ${app} with file: ${escapedPath}"
          `;
        } else {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue
            $pres = $app.Presentations.Open('${escapedPath}')
            "Launched ${app} with file: ${escapedPath}"
          `;
        }
      } else {
        if (app === 'word') {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = $${isVisible}
            $doc = $app.Documents.Add()
            "Launched ${app} with a new document"
          `;
        } else if (app === 'excel') {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = $${isVisible}
            $wb = $app.Workbooks.Add()
            "Launched ${app} with a new workbook"
          `;
        } else {
          script = `
            $app = New-Object -ComObject ${progId}
            $app.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue
            $pres = $app.Presentations.Add()
            "Launched ${app} with a new presentation"
          `;
        }
      }

      const { stdout } = await runPowerShell(script);
      return { content: [{ type: 'text' as const, text: stdout }] };
    }
  );

  // ---- office_quit ----
  server.tool(
    'office_quit',
    'Close a Microsoft Office application gracefully. Unsaved changes may be lost.',
    {
      app: z.enum(['word', 'excel', 'powerpoint']).describe('Office application to close'),
      save_changes: z.boolean().optional().describe('Whether to save open documents before closing (default: false)'),
    },
    async ({ app, save_changes }) => {
      assertWindows();

      const processMap: Record<string, string> = {
        word: 'WINWORD',
        excel: 'EXCEL',
        powerpoint: 'POWERPNT',
      };

      const progIdMap: Record<string, string> = {
        word: 'Word.Application',
        excel: 'Excel.Application',
        powerpoint: 'PowerPoint.Application',
      };

      const save = save_changes === true;
      const processName = processMap[app];
      const progId = progIdMap[app];

      const script = `
        try {
          $app = [Runtime.InteropServices.Marshal]::GetActiveObject('${progId}')
          if ($app) {
            if (${save ? '$true' : '$false'}) {
              # Save all open documents
              if ('${app}' -eq 'word') {
                foreach ($doc in $app.Documents) { $doc.Save() }
              } elseif ('${app}' -eq 'excel') {
                foreach ($wb in $app.Workbooks) { $wb.Save() }
              } elseif ('${app}' -eq 'powerpoint') {
                foreach ($pres in $app.Presentations) { $pres.Save() }
              }
            }
            $app.Quit()
            [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
            "Closed ${app} gracefully"
          }
        } catch {
          # Fallback: kill the process
          $proc = Get-Process -Name ${processName} -ErrorAction SilentlyContinue
          if ($proc) {
            $proc | Stop-Process -Force
            "Force-closed ${app} (process killed)"
          } else {
            "${app} is not currently running"
          }
        }
      `;

      const { stdout } = await runPowerShell(script);
      return { content: [{ type: 'text' as const, text: stdout }] };
    }
  );

  // ---- office_run_script ----
  server.tool(
    'office_run_script',
    'Execute a PowerShell script with COM automation to control Office applications. ' +
    'Use this to create documents, format content, add data to spreadsheets, create presentations, etc. ' +
    'The script runs in PowerShell with full access to Office COM objects. ' +
    'Example: Create a COM object with New-Object -ComObject Excel.Application, then use its API.',
    {
      script: z.string().describe(
        'PowerShell script to execute. Use New-Object -ComObject to create Office COM objects. ' +
        'The script should output its results to stdout.'
      ),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
    },
    async ({ script, timeout }) => {
      assertWindows();

      const { stdout, stderr } = await runPowerShell(script, timeout || 30000);
      let text = '';
      if (stdout) text += stdout;
      if (stderr) text += (text ? '\n\nWarnings:\n' : '') + stderr;
      if (!text) text = 'Script executed successfully (no output).';

      return { content: [{ type: 'text' as const, text }] };
    }
  );

  return server;
}

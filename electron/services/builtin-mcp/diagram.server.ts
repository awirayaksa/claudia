import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ============================================================================
// Lazy-loaded dependencies (heavy WASM / native modules)
// ============================================================================

let vizInstance: any = null;

async function getViz(): Promise<any> {
  if (!vizInstance) {
    const { instance } = require('@viz-js/viz');
    vizInstance = await instance();
  }
  return vizInstance;
}

let sharpModule: any = null;

function getSharp(): any {
  if (!sharpModule) {
    try {
      sharpModule = require('sharp');
    } catch {
      sharpModule = false; // mark as unavailable
    }
  }
  return sharpModule || null;
}

// ============================================================================
// Security: Path Validation (same pattern as filesystem.server.ts)
// ============================================================================

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  if (allowedDirs.length === 0) return true;
  const resolved = normalizePath(targetPath);
  return allowedDirs.some((dir) => {
    const normalizedDir = normalizePath(dir);
    return resolved === normalizedDir || resolved.startsWith(normalizedDir + path.sep);
  });
}

function assertPathAllowed(targetPath: string, allowedDirs: string[]): void {
  if (!isPathAllowed(targetPath, allowedDirs)) {
    throw new Error(
      `Access denied: "${targetPath}" is outside allowed directories.\n` +
      `Allowed: ${allowedDirs.join(', ')}`
    );
  }
}

function resolveRequestedPath(requestedPath: string, allowedDirs: string[]): string {
  const absoluteResolved = path.resolve(requestedPath);

  if (allowedDirs.length === 0 || isPathAllowed(absoluteResolved, allowedDirs)) {
    return absoluteResolved;
  }

  const stripped = requestedPath.replace(/^[/\\]+/, '');
  if (stripped) {
    const relativeResolved = path.resolve(allowedDirs[0], stripped);
    if (isPathAllowed(relativeResolved, allowedDirs)) {
      return relativeResolved;
    }
  }

  return absoluteResolved;
}

// ============================================================================
// SVG to PNG conversion
// ============================================================================

async function svgToPng(svgContent: string, scale: number): Promise<Buffer> {
  const sharp = getSharp();
  if (!sharp) {
    throw new Error(
      'PNG output requires the "sharp" package. Install it with: npm install sharp'
    );
  }

  // Scale the SVG for higher resolution output
  const density = Math.round(72 * scale);
  return sharp(Buffer.from(svgContent), { density })
    .png()
    .toBuffer();
}

// ============================================================================
// Server Factory
// ============================================================================

export function createDiagramServer(config?: Record<string, unknown>): McpServer {
  const allowedDirs: string[] =
    (config?.allowedDirectories as string[]) || [];

  const server = new McpServer(
    { name: 'Claudia Diagram', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ---- render_diagram ----
  server.tool(
    'render_diagram',
    'Render a diagram from DOT/Graphviz source code to an SVG or PNG image file. ' +
    'Supports all Graphviz diagram types: directed graphs (digraph), undirected graphs (graph), ' +
    'ER diagrams, network diagrams, architecture diagrams, flowcharts, class diagrams, and more. ' +
    'Use DOT language syntax (https://graphviz.org/doc/info/lang.html). ' +
    'Available layout engines: dot (hierarchical, default), neato (spring model), ' +
    'fdp (force-directed), circo (circular), twopi (radial), osage (clustered), ' +
    'sfdp (large graphs), patchwork (treemaps). ' +
    'Paths are resolved relative to the configured working directory.',
    {
      source: z.string().describe(
        'The diagram source code in DOT/Graphviz syntax. Example: digraph { A -> B -> C }'
      ),
      output_path: z.string().describe(
        'Path for the output image file. Should end with .svg or .png. ' +
        'Can be absolute or relative to the working directory.'
      ),
      engine: z.enum([
        'dot', 'neato', 'fdp', 'circo', 'twopi', 'osage', 'sfdp', 'patchwork',
      ]).optional().describe(
        'Layout engine (default: dot). Use "dot" for hierarchical/layered diagrams, ' +
        '"neato" for undirected spring-model layouts, "fdp" for force-directed placement, ' +
        '"circo" for circular layouts, "twopi" for radial layouts.'
      ),
      scale: z.number().min(0.5).max(4).optional().describe(
        'Scale factor for PNG output (default: 2). Higher values produce larger, crisper images. Ignored for SVG.'
      ),
    },
    async ({ source, output_path, engine, scale }) => {
      const resolvedPath = resolveRequestedPath(output_path, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext !== '.svg' && ext !== '.png') {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: output_path must end with .svg or .png',
          }],
          isError: true,
        };
      }

      const viz = await getViz();
      const layoutEngine = engine || 'dot';

      // Always render SVG first (needed for both SVG output and PNG conversion)
      let svgContent: string;
      try {
        svgContent = viz.renderString(source, {
          format: 'svg',
          engine: layoutEngine,
        });
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Diagram rendering error: ${err.message || err}\n\n` +
              'Please check your DOT syntax. Example of valid syntax:\n' +
              'digraph {\n  rankdir=LR\n  A -> B -> C\n}',
          }],
          isError: true,
        };
      }

      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });

      if (ext === '.svg') {
        await fs.promises.writeFile(resolvedPath, svgContent, 'utf-8');

        return {
          content: [{
            type: 'text' as const,
            text: `Diagram saved to ${resolvedPath} (SVG, engine: ${layoutEngine})`,
          }],
        };
      }

      // PNG output
      const pngScale = scale || 2;
      try {
        const pngBuffer = await svgToPng(svgContent, pngScale);
        await fs.promises.writeFile(resolvedPath, pngBuffer);

        const sizeMB = (pngBuffer.length / (1024 * 1024)).toFixed(2);
        return {
          content: [{
            type: 'text' as const,
            text: `Diagram saved to ${resolvedPath} (PNG, ${sizeMB} MB, scale: ${pngScale}x, engine: ${layoutEngine})`,
          }],
        };
      } catch (err: any) {
        // Fallback: save as SVG with a note
        const svgFallbackPath = resolvedPath.replace(/\.png$/i, '.svg');
        await fs.promises.writeFile(svgFallbackPath, svgContent, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `PNG conversion failed: ${err.message}\n` +
              `Diagram saved as SVG instead: ${svgFallbackPath}`,
          }],
        };
      }
    }
  );

  // ---- list_diagram_engines ----
  server.tool(
    'list_diagram_engines',
    'List available diagram layout engines and output formats.',
    {},
    async () => {
      const viz = await getViz();
      const engines: string[] = viz.engines || [];
      const formats: string[] = viz.formats || [];
      const sharp = getSharp();

      const engineDescriptions: Record<string, string> = {
        dot: 'Hierarchical/layered layout (best for directed graphs, flowcharts, dependency trees)',
        neato: 'Spring model layout (best for undirected graphs, network diagrams)',
        fdp: 'Force-directed placement (alternative to neato, good for large undirected graphs)',
        circo: 'Circular layout (best for cyclic structures, ring topologies)',
        twopi: 'Radial layout (best for star topologies, tree-like structures from a root)',
        osage: 'Clustered layout (best for grouped/clustered diagrams)',
        sfdp: 'Scalable force-directed (best for very large graphs, 1000+ nodes)',
        patchwork: 'Treemap/space-filling layout (best for hierarchical area visualization)',
      };

      let text = '# Available Diagram Engines\n\n';
      for (const eng of engines) {
        const desc = engineDescriptions[eng] || 'Layout engine';
        text += `- **${eng}**: ${desc}\n`;
      }

      text += '\n# Output Formats\n\n';
      text += '- **SVG**: Scalable vector graphics (default, best quality)\n';
      text += `- **PNG**: Raster image ${sharp ? '(available)' : '(requires sharp package)'}\n`;

      text += '\n# Supported Graphviz Formats (internal)\n';
      text += formats.join(', ');

      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ---- render_diagram_from_file ----
  server.tool(
    'render_diagram_from_file',
    'Render a diagram from a DOT/Graphviz source file (.dot, .gv) to an SVG or PNG image file. ' +
    'Paths are resolved relative to the configured working directory.',
    {
      input_path: z.string().describe(
        'Path to the DOT/Graphviz source file (.dot or .gv). ' +
        'Can be absolute or relative to the working directory.'
      ),
      output_path: z.string().describe(
        'Path for the output image file. Should end with .svg or .png. ' +
        'Can be absolute or relative to the working directory.'
      ),
      engine: z.enum([
        'dot', 'neato', 'fdp', 'circo', 'twopi', 'osage', 'sfdp', 'patchwork',
      ]).optional().describe('Layout engine (default: dot).'),
      scale: z.number().min(0.5).max(4).optional().describe(
        'Scale factor for PNG output (default: 2). Ignored for SVG.'
      ),
    },
    async ({ input_path, output_path, engine, scale }) => {
      const resolvedInput = resolveRequestedPath(input_path, allowedDirs);
      assertPathAllowed(resolvedInput, allowedDirs);

      const resolvedOutput = resolveRequestedPath(output_path, allowedDirs);
      assertPathAllowed(resolvedOutput, allowedDirs);

      const ext = path.extname(resolvedOutput).toLowerCase();
      if (ext !== '.svg' && ext !== '.png') {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: output_path must end with .svg or .png',
          }],
          isError: true,
        };
      }

      let source: string;
      try {
        source = await fs.promises.readFile(resolvedInput, 'utf-8');
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error reading source file: ${err.message}`,
          }],
          isError: true,
        };
      }

      const viz = await getViz();
      const layoutEngine = engine || 'dot';

      let svgContent: string;
      try {
        svgContent = viz.renderString(source, {
          format: 'svg',
          engine: layoutEngine,
        });
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Diagram rendering error: ${err.message || err}\n\n` +
              'Please check the DOT syntax in your source file.',
          }],
          isError: true,
        };
      }

      await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });

      if (ext === '.svg') {
        await fs.promises.writeFile(resolvedOutput, svgContent, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `Diagram saved to ${resolvedOutput} (SVG, engine: ${layoutEngine}, source: ${resolvedInput})`,
          }],
        };
      }

      const pngScale = scale || 2;
      try {
        const pngBuffer = await svgToPng(svgContent, pngScale);
        await fs.promises.writeFile(resolvedOutput, pngBuffer);

        const sizeMB = (pngBuffer.length / (1024 * 1024)).toFixed(2);
        return {
          content: [{
            type: 'text' as const,
            text: `Diagram saved to ${resolvedOutput} (PNG, ${sizeMB} MB, scale: ${pngScale}x, engine: ${layoutEngine}, source: ${resolvedInput})`,
          }],
        };
      } catch (err: any) {
        const svgFallbackPath = resolvedOutput.replace(/\.png$/i, '.svg');
        await fs.promises.writeFile(svgFallbackPath, svgContent, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `PNG conversion failed: ${err.message}\n` +
              `Diagram saved as SVG instead: ${svgFallbackPath}`,
          }],
        };
      }
    }
  );

  return server;
}

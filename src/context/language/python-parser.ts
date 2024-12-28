import { AbstractParser, EnclosingContext } from "../../constants";
import Parser = require("web-tree-sitter");
let parser: Parser;

// Initialize Tree-sitter parser
async function initializeParser() {
  if (!parser) {
    await Parser.init();
    parser = new Parser();
    // You'll need to load the WASM file from your node_modules
    const Lang = await Parser.Language.load(
      "/PATH_TO_WASM/tree-sitter-python.wasm"
    );
    parser.setLanguage(Lang);
  }
  return parser;
}

const processNode = (
  node: Parser.SyntaxNode,
  lineStart: number,
  lineEnd: number,
  largestSize: number,
  largestEnclosingContext: Parser.SyntaxNode | null
) => {
  const startPosition = node.startPosition;
  const endPosition = node.endPosition;

  if (startPosition.row <= lineStart && lineEnd <= endPosition.row) {
    const size = endPosition.row - startPosition.row;
    if (size > largestSize) {
      largestSize = size;
      largestEnclosingContext = node;
    }
  }
  return { largestSize, largestEnclosingContext };
};

export class PythonParser implements AbstractParser {
  private async getParser(): Promise<Parser> {
    console.log("🔍 Getting Python parser...");
    return await initializeParser();
  }

  async findEnclosingContext(
    file: string,
    lineStart: number,
    lineEnd: number
  ): Promise<EnclosingContext> {
    console.log("🚀 Starting Python parser findEnclosingContext");
    console.log(`📄 File content length: ${file.length} characters`);
    console.log(`🎯 Target lines: ${lineStart}-${lineEnd}`);

    const parser = await this.getParser();
    const tree = parser.parse(file);
    let largestEnclosingContext: Parser.SyntaxNode = null;
    let largestSize = 0;

    console.log(
      `Searching for context between lines ${lineStart} and ${lineEnd}`
    );

    // Traverse the syntax tree to find function and class definitions
    const cursor = tree.walk();
    do {
      const node = cursor.currentNode;

      // Check for function definitions and class definitions
      if (
        node.type === "function_definition" ||
        node.type === "class_definition"
      ) {
        console.log(
          `Found ${node.type} at lines ${node.startPosition.row}-${node.endPosition.row}`
        );

        const prevContext = largestEnclosingContext;
        ({ largestSize, largestEnclosingContext } = processNode(
          node,
          lineStart,
          lineEnd,
          largestSize,
          largestEnclosingContext
        ));

        if (largestEnclosingContext !== prevContext) {
          console.log(
            `New largest context found: ${node.type} with size ${largestSize}`
          );
          console.log(`Context text: ${node.text.split("\n")[0]}...`); // Print first line of context
        }
      }
    } while (cursor.gotoNextSibling() || cursor.gotoParent());

    console.log(
      "Final enclosing context:",
      largestEnclosingContext
        ? {
            type: largestEnclosingContext.type,
            start: largestEnclosingContext.startPosition.row,
            end: largestEnclosingContext.endPosition.row,
            text: largestEnclosingContext.text.split("\n")[0] + "...",
          }
        : "None found"
    );

    return {
      enclosingContext: largestEnclosingContext,
    } as EnclosingContext;
  }

  async dryRun(file: string): Promise<{ valid: boolean; error: string }> {
    console.log("🧪 Starting Python parser dryRun");
    try {
      const parser = await this.getParser();
      const tree = parser.parse(file);

      // Check if there are any ERROR nodes in the syntax tree
      let hasError = false;
      const cursor = tree.walk();

      do {
        if (cursor.currentNode.type === "ERROR") {
          hasError = true;
          break;
        }
      } while (cursor.gotoNextSibling() || cursor.gotoParent());

      return {
        valid: !hasError,
        error: hasError ? "Syntax error in Python code" : "",
      };
    } catch (exc) {
      console.error("❌ Python parser dryRun error:", exc);
      return {
        valid: false,
        error: exc.toString(),
      };
    }
  }
}

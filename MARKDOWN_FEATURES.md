# Markdown Features in Claudia

The chat interface now supports full markdown rendering for assistant responses!

## Supported Features

### Text Formatting
- **Bold text** using `**bold**`
- *Italic text* using `*italic*`
- `Inline code` using backticks
- ~~Strikethrough~~ (if using GFM)

### Headings
```markdown
# H1 Heading
## H2 Heading
### H3 Heading
#### H4 Heading
```

### Lists

**Unordered:**
```markdown
- Item 1
- Item 2
  - Nested item
```

**Ordered:**
```markdown
1. First item
2. Second item
3. Third item
```

### Code Blocks with Syntax Highlighting

````markdown
```javascript
function hello() {
  console.log("Hello, world!");
}
```

```python
def hello():
    print("Hello, world!")
```

```typescript
interface User {
  name: string;
  age: number;
}
```
````

**Features:**
- Automatic language detection
- Syntax highlighting (light/dark theme support)
- Copy button on each code block
- Language label display

### Links
```markdown
[Visit Anthropic](https://www.anthropic.com)
```
Opens in new tab by default.

### Blockquotes
```markdown
> This is a blockquote
> It can span multiple lines
```

### Tables
```markdown
| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |
| Data 4   | Data 5   | Data 6   |
```

### Horizontal Rules
```markdown
---
```

### Images
```markdown
![Alt text](image-url.jpg)
```

## Theme Support

The markdown renderer automatically adapts to your chosen theme:
- **Light mode**: Uses bright syntax highlighting
- **Dark mode**: Uses dark syntax highlighting
- **System**: Follows your OS preference

## Implementation Details

- User messages: Rendered as plain text with whitespace preservation
- Assistant messages: Full markdown rendering with syntax highlighting
- Uses `react-markdown` with GitHub Flavored Markdown (GFM) support
- Code highlighting powered by `react-syntax-highlighter` with Prism themes

## Try It Out!

Ask the assistant to:
- "Write a Python function to calculate fibonacci numbers"
- "Create a markdown table showing programming languages and their use cases"
- "Explain how async/await works with code examples"

The responses will be beautifully formatted with proper syntax highlighting!

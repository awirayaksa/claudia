# Claudia - Claude's Sassier Sister 💁‍♀️

> "Why use Claude Desktop when you can build your own? Meet Claudia - she does it her way." - Ancient Developer Proverb

Meet Claudia - she's basically Claude's rebellious younger sister who decided to do things her own way. A Windows desktop application that's Claude Desktop but with more personality, more bugs, and 100% more attitude. Built with Electron because she hates RAM and loves living dangerously.

## 🎭 Who Is Claudia?

Claudia is what happens when Claude gets a sister who codes. While her brother Claude is all professional and polished, Claudia prefers to keep things real (and occasionally broken). She's like Claude Desktop, but imagine if it was built by someone who really, really wanted to understand how everything works under the hood. Spoiler alert: Now I know, and I have regrets. Just kidding! (Mostly.)

This Electron app connects to Open WebUI and lets you chat with AI models while pretending you're using the official Claude Desktop app. Claudia might be rougher around the edges than her brother, but she's got character. Your friends will be impressed. Or confused. Probably confused.

## ✨ Features (That Actually Work!)

- 💬 **Chat interface** - She talks back! You type, AI responds. Revolutionary stuff here.
- 🎥 **Real-time streaming** - Watch the words appear like magic! (It's not magic, it's Server-Sent Events)
- 📎 **File uploads** - Drag, drop, pray she doesn't crash
- 💾 **Conversation history** - So you can remember that embarrassing prompt from last Tuesday
- 📁 **Project system** - Organize your conversations like the productive person you pretend to be
- 🎨 **Dark mode** - Because your eyes deserve better at 2 AM
- 🔧 **MCP Server Support** - Give your AI superpowers with 26 custom tools! (May or may not crash)
- 🤖 **Auto-tool calling** - She'll use tools automatically. It's like giving her a Swiss Army knife, but digital.
- 🧠 **Reasoning effort** - Tell her how hard to think, right from the prompt: `--effort high fix this bug`. Or `/effort low` on its own to keep it that way for the session.

## 🛠️ Technology Stack (AKA "Things That Will Break")

- **Electron 28** - Because why use 100MB when you can use 300MB?
- **React 18** - Hooks everywhere! useState this, useEffect that!
- **TypeScript** - JavaScript with training wheels (that we ignore with `any`)
- **Redux Toolkit** - Global state go brrrrr
- **Tailwind CSS** - `className="flex items-center justify-between bg-surface p-4 rounded-lg shadow-md hover:bg-surface-hover transition-colors duration-200"` - yeah, super readable
- **Vite** - Fast builds so you can break things faster
- **Electron Builder** - Turns your 300MB app into a 150MB installer. Math!

## 🚀 Getting Started (Good Luck!)

### Prerequisites (Things You Need Before the Pain Begins)

- Node.js 18+ (the higher the better, like your caffeine intake)
- npm or yarn (pick your poison)
- An Open WebUI instance (because we're too lazy to build our own backend)
- Patience (not included in package.json)
- Coffee ☕ (lots of it)

### Installation (The Fun Part)

1. **Clone this bad girl:**
```bash
git clone <repository-url>
cd claudia
# Take a moment to appreciate what you're about to do
```

2. **Install dependencies** (go make coffee, this takes a while):
```bash
npm install
# Meanwhile: 3000 packages, 200MB node_modules, 1 questionable life choice
```

3. **Start the dev server:**
```bash
npm run dev
# If it doesn't work on the first try, you're doing it right!
```

4. **Watch her compile:**
```
✓ 1 modules transformed
✓ 5 modules transformed
✓ 42 modules transformed
[vite] hmr update /src/App.tsx
# This is fine 🔥
```

## 📦 Build Commands (For When You Want to Share the Pain)

```bash
# Development (AKA "Fix Bugs Simulator")
npm run dev              # Hot reload your mistakes in real-time!

# Production Build (AKA "Package Your Bugs Professionally")
npm run build            # Pray to the TypeScript gods
npm run build:win        # Creates a 150MB installer. You're welcome, users!

# Code Quality (LOL)
npm run lint             # Finds 127 problems (125 warnings, 2 errors)
npm run format           # Makes your code pretty (but not functional)
npm run type-check       # TypeScript: "I found 47 issues" You: "any goes brrr"
```

## ⚙️ Configuration (The "Make It Work" Part)

First time? Here's how to not break things:

1. Click the Settings button (top-right, you can't miss it)
2. Enter your Open WebUI URL (usually `http://localhost:8080` if you're cool)
3. Paste your API key (from Settings > Account in Open WebUI)
   - **Pro tip:** Don't commit this to git. We've all been there.
4. Pick a model (any model, they're all smarter than us anyway)
5. Click "Save" and hope for the best

### MCP Servers (For the Brave)

Want to give Claudia actual superpowers? Configure MCP servers!

1. Go to Settings > MCP Servers
2. Click "Import from Claude Desktop" if you're lazy (recommended)
3. Or manually add servers if you enjoy pain
4. Watch Claudia use 26 different tools to accomplish what you could've googled

**Known Issues:**
- API key resets on startup ~~(we're working on it)~~ FIXED! 🎉
- First message doesn't show up ~~(just send it again)~~ FIXED! 🎉
- "View Logs" button might make you cry (errors are scary)
- Tools show in settings but not in chat ~~(turn it off and on again)~~ FIXED! 🎉
- Input stays disabled after "New Chat" ~~(refresh the page)~~ FIXED! 🎉

## 📂 Project Structure (Where Stuff Lives)

```
claudia/
├── electron/              # The main process (where Electron lives)
│   ├── main.ts           # Entry point (where it all begins)
│   ├── preload.ts        # IPC bridge (the middleman)
│   ├── handlers/         # IPC handlers (the workers)
│   └── services/         # Backend logic (the brain)
├── src/                  # The renderer process (where React lives)
│   ├── components/       # React components (UI building blocks)
│   │   ├── chat/        # Chat stuff (where conversations happen)
│   │   ├── settings/    # Settings panels (where you configure things)
│   │   └── common/      # Reusable components (DRY principle!)
│   ├── services/        # API services (talk to backends)
│   ├── store/           # Redux store (global state chaos)
│   ├── hooks/           # Custom React hooks (useThis, useThat)
│   └── types/           # TypeScript types (type safety theater)
└── public/              # Static files (images, favicon, etc)
```

## 🎯 Implementation Status (What Works and What Doesn't)

### ✅ Phase 1-4: Foundation & Core Features - COMPLETE!
- [x] Project setup (she compiles! 🎉)
- [x] Basic UI (it's ugly but functional)
- [x] Chat with streaming (words go brrrr)
- [x] File uploads (drag and drop works 60% of the time, every time)
- [x] Settings panel (stores your API key in the void)
- [x] MCP Server integration (26 tools ready to rumble)
- [x] Auto-tool calling (Claudia goes full power tools mode)
- [x] Error handling (beautiful error messages you'll never read)
- [x] Log viewing (for when things go wrong, which is often)

### 🎨 Recent Improvements (We Fixed Stuff!)
- [x] API key now persists (encrypted! fancy!)
- [x] First message actually shows up (groundbreaking!)
- [x] Tools work in chat (not just settings)
- [x] "New Chat" button doesn't break everything
- [x] Auto-focus input after response (keyboard warriors rejoice!)
- [x] Removed annoying blue outline (cleaner vibes)

### 🚧 Known Bugs (Features, Really)
- MCP server crashes on port conflict (fix: use different port, duh)
- Occasionally decides to clear your chat (it's a feature: memory management)
- Tool calls sometimes timeout (patience is a virtue)
- She uses more RAM than Chrome (achievement unlocked!)

## 🤝 Contributing (Join the Chaos)

Found a bug? Of course you did. Here's what you can do:

1. **Open an issue** - Describe the bug, include screenshots, tell us how you broke it
2. **Submit a PR** - Fix it yourself! We believe in you!
3. **Star the repo** - Makes us feel good, costs you nothing
4. **Tell your friends** - Misery loves company

## 📜 License

MIT - Do whatever you want with this code. Sell it, break it, improve it, blame it on someone else. We don't judge.

## 🙏 Acknowledgments

- **Anthropic** - For making Claude, the big brother we're emulating
- **Open WebUI** - For the backend we're too lazy to build
- **Coffee** - The real MVP
- **You** - For actually reading this far. You're a real one.

## 🐛 Troubleshooting (When Things Go Wrong)

### "She won't start!"
- Did you run `npm install`?
- Did you restart your computer?
- Did you sacrifice a rubber duck to the debugging gods?

### "The API key keeps resetting!"
- ~~We're working on it~~ FIXED! Just update to the latest version.

### "I see the tools in settings but not in chat!"
- ~~Close the app, open the app, maybe it'll work~~ FIXED! The tools now sync properly.

### "Everything is broken!"
- Welcome to software development!
- Check the console (F12) for red text
- Read the error message (revolutionary concept)
- Google the error (we all do it)
- Give up and file an issue

## 🎮 Pro Tips

1. **Enable streaming** - It's way cooler than waiting
2. **Use dark mode** - Your eyes will thank you
3. **Save your conversations** - Future you will appreciate it
4. **Don't commit your API key** - Learn from our mistakes
5. **Read the logs** - They're funnier than you think
6. **Press Enter to send** - Shift+Enter for new lines (game changer!)
7. **Auto-focus is your friend** - Type away without clicking!
8. **Dial the thinking** - `--effort high` (or `minimal`, `low`, `medium`, `xhigh`) anywhere in a message applies to that message only. `/effort high` alone sets it for the whole session, `/effort default` hands it back to the provider. Set your day-to-day default in Settings → Preferences.
9. **Effort follows the model** - Each model only gets the tiers it actually accepts (Qwen3.8 takes `low`/`medium`/`xhigh`, most others `minimal`/`low`/`medium`/`high`). Ask for a tier a model doesn't have and Claudia picks its nearest one — `--effort max` always means "as hard as this model goes".

---

**Made with ❤️, 🤬, and way too much ☕**

*"It's not a bug, it's a feature we haven't documented yet"* - Every developer ever

**P.S.** If this README made you smile, give it a ⭐. If it made you cry, well... welcome to programming! 🎉

**P.P.S.** Yes, Claudia is Claude's sister. No, she doesn't have his polish. Yes, that's the point. 💁‍♀️

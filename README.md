# jupyter-variables

Browse and edit a Jupyter kernel's namespace in a table.

Everything the kernel is holding, with its type and the best representation it can give — a dataframe's shape, an image's thumbnail, a Markdown `_repr_`. Names filter as you type, values can be edited in place, and any of them opens in jupyter-explorer.

## Features

- **The whole namespace**: every user-defined name, with its type and value.
- **Rich values**: renders the Markdown, HTML or image representation a kernel offers, falling back to its text.
- **Edit in place**: double-click a value, type a new one, and it is assigned in the kernel.
- **Filter by name**: a filter field narrows the table as you type.
- **Auto-refresh**: follow the kernel and re-read the namespace every time it falls idle.
- **Open in the grid**: a name opens in jupyter-explorer, when that package is installed.

## Installation

To install `jupyter-variables` search for _jupyter-variables_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/jupyter-variables`.

It reads its kernels from [`jupyter-repl`](https://github.com/lumine-code/jupyter-repl), which needs to be installed too.

## Commands

Commands available in `atom-workspace`:

- `jupyter-variables:toggle`: open the panel, or close it when it is open,
- `jupyter-variables:toggle-focus`: focus the panel, or return focus to the editor when it already has it,
- `jupyter-variables:refresh`: re-read the namespace now.

## Usage

Only Python kernels are supported; the panel says so rather than showing an empty table for anything else.

Auto-refresh is off by default. It re-reads the namespace every time the kernel falls idle, which costs a round trip after every cell — worth it while you are working through a dataframe, wasteful during a long run.

Reading the namespace never calls a `_repr_` method on a large value: those materialise the object, which can hang the kernel for no benefit. A dataframe over ten thousand cells, or a list over a thousand entries, shows a summary line instead.

## Customization

Paste this into your `styles.css` to fit more names on screen:

```css
.jupyter-variables {
  .variable-table td {
    padding: 0.1em 0.3em;
  }
}
```

## Services

- **jupyter.kernel** (`^1.0.0`): consumed to follow the active kernel and read its namespace.
- **jupyter.explorer** (`^1.0.0`): consumed to open a name in jupyter-explorer.
- **jupyter.output** (`^1.0.0`): consumed to colour and sanitize values with jupyter-repl's renderers; plain text without it.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!

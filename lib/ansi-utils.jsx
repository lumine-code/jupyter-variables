const etch = require("@lumine-code/etch"); // JSX factory
const Anser = require("anser");

/**
 * Truncate text to prevent crashes from large outputs.
 *
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: from config, 0 = no limit)
 * @returns {{ text: string, truncated: boolean }} - Truncated text and flag
 */
function truncateOutput(text, maxLength = atom.config.get("jupyter-repl.outputMaxLength")) {
  if (!text || typeof text !== "string") {
    return { text: text || "", truncated: false };
  }
  // 0, undefined, null, or negative means no limit
  if (!maxLength || maxLength <= 0 || text.length <= maxLength) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxLength),
    truncated: true,
  };
}

/**
 * Adjust RGB color for better contrast when it matches the background.
 * Lightens dark colors and darkens light colors.
 *
 * @param {string} rgbValues - RGB values as "r, g, b" string
 * @returns {string} - Adjusted RGB values
 */
function adjustColorForContrast(rgbValues) {
  const parts = rgbValues.split(",").map((p) => parseInt(p.trim(), 10));
  if (parts.length !== 3) return rgbValues;

  const [r, g, b] = parts;
  // Calculate relative luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  // Adjust by 100 in the opposite direction of luminance
  if (luminance < 0.5) {
    // Dark color - lighten it
    return `${Math.min(255, r + 100)}, ${Math.min(255, g + 100)}, ${Math.min(255, b + 100)}`;
  } else {
    // Light color - darken it
    return `${Math.max(0, r - 100)}, ${Math.max(0, g - 100)}, ${Math.max(0, b - 100)}`;
  }
}

/**
 * Render text containing ANSI escape sequences as etch virtual nodes.
 *
 * A plain function rather than a component: etch calls a function tag with
 * `new`, so only classes can be tags, and there is no state to keep here.
 *
 * @param {string} text - Text containing ANSI escape sequences
 * @returns {Array} - Virtual nodes for the coloured runs
 */
function ansiNodes(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const parsed = Anser.ansiToJson(text, { remove_empty: true });

  return parsed.map((part) => {
    const { content, fg, bg, decoration } = part;
    if (!content) return null;

    const style = {};
    let fgValue = fg || null;
    const bgValue = bg || null;

    // Fix matching foreground/background colors
    if (fgValue && bgValue && fgValue === bgValue) {
      fgValue = adjustColorForContrast(fgValue);
    }

    if (fgValue) style.color = `rgb(${fgValue})`;
    if (bgValue) style.backgroundColor = `rgb(${bgValue})`;
    if (decoration === "bold") style.fontWeight = "bold";
    else if (decoration === "italic") style.fontStyle = "italic";
    else if (decoration === "underline") style.textDecoration = "underline";

    if (Object.keys(style).length > 0) {
      return <span style={style}>{content}</span>;
    }
    return content;
  });
}

/**
 * Escape carriage return characters by simulating terminal behavior.
 * When \r is encountered, it overwrites the current line from the beginning.
 *
 * @param {string} text - Text with possible carriage returns
 * @returns {string} - Processed text with carriage returns applied
 */
function escapeCarriageReturn(text) {
  if (!text || typeof text !== "string") {
    return text;
  }

  const lines = text.split("\n");
  const result = [];

  for (let line of lines) {
    if (line.includes("\r")) {
      // Split by \r and process each segment
      const segments = line.split("\r");
      let currentLine = "";

      for (const segment of segments) {
        if (segment === "") {
          // Empty segment means \r at start or consecutive \r
          currentLine = "";
        } else {
          // Overwrite from the beginning with the new segment
          currentLine = segment + currentLine.slice(segment.length);
        }
      }
      result.push(currentLine);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

module.exports = { truncateOutput, ansiNodes, escapeCarriageReturn };

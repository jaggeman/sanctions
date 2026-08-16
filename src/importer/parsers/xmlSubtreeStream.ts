import * as sax from 'sax';
import * as fs from 'fs-extra';

/**
 * Generic SAX-based "stream one subtree at a time" engine, factored out of
 * the EU parser's fix for issue #5 so issue #31 (UN/US) can reuse the exact
 * same, already-proven stack machine instead of hand-copying it. Builds
 * attribute-prefixed (`@_name`) + nested-element objects, matching the shape
 * fast-xml-parser's `ignoreAttributes: false` DOM parse used to produce, so
 * per-record mapping logic written against that shape needs no changes.
 *
 * Only one `recordTagName` subtree is ever held in memory at a time; the rest
 * of a multi-megabyte document is never materialised as a tree.
 */

function stripPrefix(name: string): string {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function pushChild(parent: Record<string, any>, tagName: string, child: any) {
  const existing = parent[tagName];
  if (existing === undefined) {
    parent[tagName] = child;
  } else if (Array.isArray(existing)) {
    existing.push(child);
  } else {
    parent[tagName] = [existing, child];
  }
}

interface Frame {
  tagName: string;
  node: Record<string, any>;
  text: string;
  childCount: number;
}

/**
 * `onSubtree` may return a Promise; when it does, parsing pauses on the
 * underlying file stream until it resolves, so a caller can batch records and
 * await a Firestore write without racing arbitrarily far ahead of what has
 * actually been persisted.
 *
 * Resolves to the number of `recordTagName` subtrees seen and handed to
 * `onSubtree` — mapping/validation decisions (e.g. skipping a record with an
 * unsafe id) are the caller's own responsibility inside `onSubtree`.
 */
export async function streamXmlRecords(
  filePath: string,
  recordTagName: string,
  onSubtree: (subtree: any) => void | Promise<void>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const parserStream = sax.createStream(true, { trim: false, lowercase: false });
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' });

    const stack: Frame[] = [];
    let depth = 0;
    let recordDepth = -1;
    let emitted = 0;
    let settled = false;
    const pending: Promise<void>[] = [];
    // issue #171: a single read chunk can yield several closetag events
    // synchronously, so more than one onSubtree call can be outstanding at
    // once. pause()/resume() is a binary switch, not a counter — resuming as
    // soon as the FIRST of several outstanding promises settles lets the
    // stream race ahead of a still-in-flight flush. Only resume once every
    // currently-outstanding promise has settled.
    let outstanding = 0;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      reject(err);
    };

    parserStream.on('opentag', (node: sax.Tag) => {
      depth++;
      const tagName = stripPrefix(node.name);
      const obj: Record<string, any> = {};
      for (const [rawAttrName, rawVal] of Object.entries(node.attributes)) {
        obj[`@_${stripPrefix(rawAttrName)}`] = String(rawVal).trim();
      }
      stack.push({ tagName, node: obj, text: '', childCount: 0 });

      if (tagName === recordTagName && recordDepth === -1) {
        recordDepth = depth;
      }
    });

    parserStream.on('text', (t: string) => {
      if (stack.length > 0) stack[stack.length - 1].text += t;
    });

    parserStream.on('closetag', (rawName: string) => {
      const tagName = stripPrefix(rawName);
      const frame = stack.pop();
      depth--;
      if (!frame) return;

      const hasAttrs = Object.keys(frame.node).length > 0;
      const value: any = !hasAttrs && frame.childCount === 0 ? frame.text.trim() : frame.node;

      if (stack.length === 0) return; // closed the document root itself

      if (tagName === recordTagName && depth + 1 === recordDepth) {
        recordDepth = -1;
        emitted++;

        let result: void | Promise<void>;
        try {
          result = onSubtree(value);
        } catch (err) {
          fail(err as Error);
          return;
        }
        if (result && typeof (result as Promise<void>).then === 'function') {
          readStream.pause();
          outstanding++;
          const awaited = (result as Promise<void>).then(
            () => {
              outstanding--;
              if (outstanding === 0) readStream.resume();
            },
            (err) => {
              outstanding--;
              fail(err);
              throw err;
            },
          );
          pending.push(awaited);
        }
        return; // never attached to the parent — nothing to hold onto
      }

      const parent = stack[stack.length - 1];
      parent.childCount++;
      pushChild(parent.node, tagName, value);
    });

    parserStream.on('error', (err: Error) => {
      fail(err);
    });

    readStream.on('error', (err) => fail(err));

    parserStream.on('end', () => {
      Promise.all(pending).then(() => {
        if (settled) return;
        settled = true;
        resolve(emitted);
      }, fail);
    });

    readStream.pipe(parserStream as unknown as NodeJS.WritableStream);
  });
}

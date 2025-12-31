return await (async () => {
  // Using Obsidian Local REST API instead of URL scheme
  let BASE = "http://127.0.0.1:27123";
  // Support multiple vaults with per-vault tokens and prompt user to choose
  const VAULTS = {
    "AMM": "833177e27c54e50f4365fd0201df942127236353ab33e7509aea056045869ff2",
    "Sleep": "b20f1c0d907bd4e6764cb7fbc4e501ce35579a987eba6fa6440f61cfe3309cfa",
    "Anki": "c093bf3b1a3cb843437461668cfb38edc1339cc5c93925289516f904df61a3bb"
  };
  let VAULT = "AMM";
  try {
    if (typeof prompt === 'function') {
      const choice = (prompt('Choose Obsidian vault ("AMM", "Sleep", or "Anki"): ', VAULT) || '').trim();
      if (choice && VAULTS[choice]) VAULT = choice;
    }
  } catch (_) {}
  // Per-vault BASE override
  if (VAULT === 'Sleep') BASE = 'http://127.0.0.1:27122';
  else if (VAULT === 'Anki') BASE = 'http://127.0.0.1:27121';
  const TOKEN = VAULTS[VAULT];

  const pane = Zotero.getActiveZoteroPane();
  const selected = pane.getSelectedItems() || [];
  if (!selected.length) return "";

  const is8CharKey = (k) => /^[A-Za-z0-9]{8}$/.test(k);

  const getTitle = (item) => {
    try {
      if (typeof item.getDisplayTitle === 'function') return item.getDisplayTitle();
      if (typeof item.getField === 'function') return item.getField('title') || '';
    } catch (_) {}
    return '';
  };

  // Detect web-link attachments and return a meaningful label
  const getFilename = (att) => {
    try {
      const linkMode = typeof att?.attachmentLinkMode !== 'undefined' ? att.attachmentLinkMode : null;
      const LINKED_URL = Zotero?.Attachments?.LINK_MODE_LINKED_URL;
      const url = (typeof att?.getField === 'function') ? (att.getField('url') || '') : '';

      // Exception: Web Link attachment (no local file) → use its URL as the "filename"
      if ((LINKED_URL != null && linkMode === LINKED_URL) || (url && !(typeof att?.getFilename === 'function' && att.getFilename()))) {
        return url || '(web link)';
      }

      if (typeof att?.getFilename === 'function') return att.getFilename() || '';
      return getTitle(att) || '(no filename)';
    } catch (_) { return '(no filename)'; }
  };

  const getAnnotationsFromAttachment = async (att) => {
    let anns = [];
    try {
      if (typeof att.getAnnotations === 'function') {
        anns = await att.getAnnotations(); // Zotero 7+
      } else if (typeof att.getChildren === 'function') {
        let children = await att.getChildren();
        if (children.length && typeof children[0] === 'number') {
          children = children.map(id => Zotero.Items.get(id));
        }
        anns = children.filter(ch => ch && ch.itemType === 'annotation');
      }
    } catch (_) {}
    return anns || [];
  };

  // Keep entries per attachment (do NOT merge by filename)
  // id -> { label, keys:Set, att: Zotero.Item }
  const entriesById = new Map();
  const ensureEntryForAttachment = (att) => {
    const id = (att && typeof att.id !== 'undefined') ? att.id : `missing:${Math.random().toString(36).slice(2, 10)}`;
    if (!entriesById.has(id)) {
      entriesById.set(id, { label: getFilename(att), keys: new Set(), att });
    }
    return { id, entry: entriesById.get(id) };
  };

  const overallKeySet = new Set();

  for (const item of selected) {
    // Case A: annotation selected
    if (item?.itemType === 'annotation') {
      const parentAttachment = item.parentItem ? Zotero.Items.get(item.parentItem) : null;
      ensureEntryForAttachment(parentAttachment);
      if (item.key && is8CharKey(item.key)) {
        entriesById.get(parentAttachment?.id || [...entriesById.keys()][entriesById.size - 1]).keys.add(item.key);
        overallKeySet.add(item.key);
      }
      continue;
    }

    // Case B: attachment selected
    if (typeof item.isAttachment === 'function' && item.isAttachment()) {
      const { entry } = ensureEntryForAttachment(item);
      const anns = await getAnnotationsFromAttachment(item);
      for (const ann of anns) {
        if (ann?.key && is8CharKey(ann.key)) {
          entry.keys.add(ann.key);
          overallKeySet.add(ann.key);
        }
      }
      continue;
    }

    // Case C: top-level item selected
    const attIDs = typeof item.getAttachments === 'function' ? item.getAttachments() : [];
    for (const id of attIDs) {
      const att = Zotero.Items.get(id);
      if (!att || !(typeof att.isAttachment === 'function' && att.isAttachment())) continue;
      const { entry } = ensureEntryForAttachment(att);
      const anns = await getAnnotationsFromAttachment(att);
      for (const ann of anns) {
        if (ann?.key && is8CharKey(ann.key)) {
          entry.keys.add(ann.key);
          overallKeySet.add(ann.key);
        }
      }
    }
  }

  // Query Obsidian Local REST API once per key (boolean queries not supported)
  const keys = Array.from(overallKeySet).sort();

  async function searchObsidian(key) {
    try {
      const res = await fetch(`${BASE}/search/simple/?query=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'x-obsidian-vault': VAULT }
      });
      if (!res.ok) {
        try { await res.text(); } catch {}
        return [];
      }
      try {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data
            .filter(item => item && typeof item === 'object')
            .map(item => item.filename)
            .filter(name => typeof name === 'string');
        }
        return [];
      } catch (e) {
        try { await res.text(); } catch {}
        return [];
      }
    } catch (e) {
      return [];
    }
  }

  const obsidianByKey = Object.create(null);
  for (const k of keys) {
    obsidianByKey[k] = await searchObsidian(k);
  }

  // Date tag in YYYY-MM-DD format
  const ymd = new Date().toISOString().slice(0, 10);

  // Format the plain-text mapping showing ONLY keys found in BOTH Obsidian and Zotero
  // "Zotero filename": "file.pdf"
  // 	"Obsidian filename": "file.md"
  // 		KEY1
  // 		KEY2
  const entries = Array.from(entriesById.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  let output = "";
  for (const { label, keys: keySet, att } of entries) {
    const line1 = `"Zotero filename": "${label || '(no filename)'}"`;
    const sortedKeys = Array.from(keySet).sort();

    // We'll collect tags to add to the Zotero items (attachment and its parent)
    const tagsToAdd = [];

    if (sortedKeys.length === 0) {
      output += (output ? "\n\n" : "") + line1 + "\n" + "No annotation keys found." + `\n${ymd} No annotation keys found in ${VAULT}`;
      tagsToAdd.push(`${ymd} No annotation keys found in ${VAULT}`);
    } else {
      // Group keys under each Obsidian filename
      const obsidianToKeys = new Map();
      for (const k of sortedKeys) {
        const names = obsidianByKey[k] || [];
        for (const name of names) {
          if (!obsidianToKeys.has(name)) obsidianToKeys.set(name, new Set());
          obsidianToKeys.get(name).add(k);
        }
      }

      if (obsidianToKeys.size === 0) {
        output += (output ? "\n\n" : "") + line1 + "\n" + "No matching keys found." + `\n${ymd} No matching keys found in ${VAULT}`;
        tagsToAdd.push(`${ymd} No matching keys found ${VAULT}`);
      } else {
        const lines = [];
        const sortedNames = Array.from(obsidianToKeys.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        for (const name of sortedNames) {
          lines.push(`\t"Obsidian filename": "${name}"`);
          const klist = Array.from(obsidianToKeys.get(name)).sort();
          for (const k of klist) {
            lines.push(`\t\t  ${k}`);
          }
          const tag = `${ymd} ${klist.length} matching key${klist.length === 1 ? '' : 's'} found in "${name}" in ${VAULT}`;
          lines.push(`\t\t  ${tag}`);
          tagsToAdd.push(tag);
          

        }
        const block = [line1, ...lines].join("\n");
        output += (output ? "\n\n" : "") + block;
      }
    }

    // Apply tags to the actual Zotero items (attachment and parent item if present)
    try {
      if (tagsToAdd.length) {
        await Zotero.DB.executeTransaction(async () => {
          const targets = [];
          if (att) targets.push(att);
          try {
            const parent = att && att.parentItem ? Zotero.Items.get(att.parentItem) : null;
            if (parent && typeof parent.isRegularItem === 'function' && parent.isRegularItem()) {
              targets.push(parent);
            }
          } catch (_) {}
          for (const it of targets) {
            for (const tg of tagsToAdd) {
              // type=0 for manual tag
              it.addTag(tg, 0);
            }
            await it.save();
          }
        });
      }
    } catch (e) {
      // Non-fatal: keep outputting text even if tagging fails
    }
  }

  return output || `No annotation keys found.\n${ymd} No annotation keys found in ${VAULT}`;
})();

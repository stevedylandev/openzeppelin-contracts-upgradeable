const { version } = require('../../package.json');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

module.exports['oz-version'] = () => version;

module.exports['readme-path'] = opts => {
  const pageId = opts.data.root.id;
  const basePath = pageId.replace(/\.(adoc|mdx)$/, '');
  return 'contracts/' + basePath + '/README.adoc';
};

module.exports.readme = readmePath => {
  try {
    if (fs.existsSync(readmePath)) {
      const readmeContent = fs.readFileSync(readmePath, 'utf8');
      return processAdocContent(readmeContent);
    }
  } catch (error) {
    console.warn(`Warning: Could not process README at ${readmePath}:`, error.message);
  }
  return '';
};

module.exports.names = params => params?.map(p => p.name).join(', ');

// Simple function counter for unique IDs
const functionNameCounts = {};

module.exports['simple-id'] = function (name) {
  if (!functionNameCounts[name]) {
    functionNameCounts[name] = 1;
    return name;
  } else {
    functionNameCounts[name]++;
    return `${name}-${functionNameCounts[name]}`;
  }
};

module.exports['reset-function-counts'] = function () {
  Object.keys(functionNameCounts).forEach(key => delete functionNameCounts[key]);
  return '';
};

module.exports.eq = (a, b) => a === b;
module.exports['starts-with'] = (str, prefix) => str && str.startsWith(prefix);

// Process natspec content with {REF} and link replacement
module.exports['process-natspec'] = function (natspec, opts) {
  if (!natspec) return '';

  const currentPage = opts.data.root.__item_context?.page || opts.data.root.id;
  const links = getAllLinks(opts.data.site.items, currentPage);

  return processReferences(natspec, links, opts.data.site.items);
};

module.exports['typed-params'] = params => {
  return params?.map(p => `${p.type}${p.indexed ? ' indexed' : ''}${p.name ? ' ' + p.name : ''}`).join(', ');
};

const slug = (module.exports.slug = str => {
  if (str === undefined) {
    throw new Error('Missing argument');
  }
  return str.replace(/\W/g, '-');
});

// Link generation and caching
const linksCache = new WeakMap();

// Add helper to check if this is an upgradeable repo
module.exports['is-upgradeable-repo'] = () => {
  return process.cwd().includes('contracts-upgradeable');
};

// Add source repo helper
module.exports['source-repo'] = () => {
  const isUpgradeable = process.cwd().includes('contracts-upgradeable');
  return isUpgradeable ? 'openzeppelin-contracts-upgradeable' : 'openzeppelin-contracts';
};

function getAllLinks(items, currentPage) {
  if (currentPage) {
    const cacheKey = currentPage;
    let cache = linksCache.get(items);
    if (!cache) {
      cache = new Map();
      linksCache.set(items, cache);
    }

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
  }

  const res = {};
  const currentPagePath = currentPage ? currentPage.replace(/\.mdx$/, '') : '';

  for (const item of items) {
    const pagePath = item.__item_context.page.replace(/\.mdx$/, '');
    const linkPath = generateLinkPath(pagePath, currentPagePath, item.anchor);

    // Generate xref keys for legacy compatibility
    res[`xref-${item.anchor}`] = linkPath;

    // Generate original case xref keys
    if (item.__item_context && item.__item_context.contract) {
      let originalAnchor = item.__item_context.contract.name + '-' + item.name;
      if ('parameters' in item) {
        const signature = item.parameters.parameters.map(v => v.typeName.typeDescriptions.typeString).join(',');
        originalAnchor += slug('(' + signature + ')');
      }
      res[`xref-${originalAnchor}`] = linkPath;
    }

    res[slug(item.fullName)] = `[\`${item.fullName}\`](${linkPath})`;
  }

  if (currentPage) {
    let cache = linksCache.get(items);
    if (!cache) {
      cache = new Map();
      linksCache.set(items, cache);
    }
    cache.set(currentPage, res);
  }

  return res;
}

function generateLinkPath(pagePath, currentPagePath, anchor) {
  if (
    currentPagePath &&
    (pagePath === currentPagePath || pagePath.split('/').pop() === currentPagePath.split('/').pop())
  ) {
    return `#${anchor}`;
  }

  if (currentPagePath) {
    const currentParts = currentPagePath.split('/');
    const targetParts = pagePath.split('/');

    // Find common base
    let i = 0;
    while (i < currentParts.length && i < targetParts.length && currentParts[i] === targetParts[i]) {
      i++;
    }

    const upLevels = Math.max(0, currentParts.length - 1 - i);
    const downPath = targetParts.slice(i);

    if (upLevels === 0 && downPath.length === 1) {
      return `${downPath[0]}#${anchor}`;
    } else if (upLevels === 0) {
      return `${downPath.join('/')}#${anchor}`;
    } else {
      const relativePath = '../'.repeat(upLevels) + downPath.join('/');
      return `${relativePath}#${anchor}`;
    }
  }

  return `${pagePath}#${anchor}`;
}

// Process {REF} and other references
function processReferences(content, links, items) {
  let result = content;

  // Handle {REF:Contract.method} patterns
  result = result.replace(/\{REF:([^}]+)\}/g, (match, refId) => {
    const resolvedRef = resolveReference(refId, links);
    return resolvedRef || match;
  });

  // Handle double bracket {{name}} patterns - these often reference base contracts
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    const resolvedRef = resolveDoubleReference(name, links, items);
    return resolvedRef || match;
  });

  // Handle AsciiDoc-style {xref-...}[text] patterns
  result = result.replace(/\{(xref-[-._a-z0-9]+)\}\[([^\]]*)\]/gi, (match, key, linkText) => {
    const replacement = links[key];
    return replacement ? `[${linkText}](${replacement})` : match;
  });

  // Replace single bracket {link-key} placeholders - try base contract resolution first
  result = result.replace(/\{([^}]+)\}/gi, (match, key) => {
    // Skip escaped braces like \{id\} which are literal text
    if (match.startsWith('\\{')) {
      return match;
    }

    // Handle complex function signatures with arrays and multiple parameters
    if (key.includes('-') && (key.includes('[]') || key.includes('address') || key.includes('uint'))) {
      return resolveContractFunctionReference(key, links, items) || match;
    }

    // Handle underscore-prefixed functions like _signableUserOpHash
    if (key.startsWith('_')) {
      // Try to find local function first
      const localMatch = findBestMatch(key, links);
      if (localMatch) return localMatch;

      // If not found locally, it might be from a base contract (without Upgradeable suffix)
      // We'll assume it's internal and not generate external links for private functions
      return match;
    }

    // First try as a base contract reference
    if (isBaseContractReference(key)) {
      const resolvedRef = resolveDoubleReference(key, links, items);
      if (resolvedRef) return resolvedRef;
    }

    // Then try normal local link matching
    const replacement = findBestMatch(key, links);
    return replacement || match;
  });

  return cleanupContent(result);
}

function resolveReference(refId, links) {
  // Try direct match first
  const directKey = `xref-${refId.replace(/\./g, '-')}`;
  if (links[directKey]) {
    const parts = refId.split('.');
    const displayText = parts.length > 1 ? `${parts[0]}.${parts[1]}` : refId;
    return `[\`${displayText}\`](${links[directKey]})`;
  }

  // Try fuzzy matching
  const matchingKeys = Object.keys(links).filter(key => {
    const normalizedKey = key.replace('xref-', '').toLowerCase();
    const normalizedRef = refId.replace(/\./g, '-').toLowerCase();
    return normalizedKey.includes(normalizedRef) || normalizedRef.includes(normalizedKey);
  });

  if (matchingKeys.length > 0) {
    const bestMatch = matchingKeys[0];
    const parts = refId.split('.');
    const displayText = parts.length > 1 ? `${parts[0]}.${parts[1]}` : refId;
    return `[\`${displayText}\`](${links[bestMatch]})`;
  }

  return null;
}

function resolveDoubleReference(name, links, items) {
  // First try to find it in current repo links
  const localKey = slug(name);
  if (links[localKey]) {
    return links[localKey];
  }

  // Try xref pattern
  const xrefKey = `xref-${name.replace(/\./g, '-')}`;
  if (links[xrefKey]) {
    return `[\`${name}\`](${links[xrefKey]})`;
  }

  // Handle contract-function pattern: Contract-functionName or Contract-constructor
  if (name.includes('-')) {
    return resolveContractFunctionReference(name, links, items);
  }

  // If not found locally, assume it's from base openzeppelin-contracts repo
  // Create external link to the base contracts documentation
  if (isBaseContractReference(name)) {
    const baseUrl = 'https://docs.openzeppelin.com/contracts/api';
    const category = getSmartContractCategory(name, items);
    if (category) {
      return `[\`${name}\`](${baseUrl}/${category}#${name})`;
    }
  }

  return null;
}

function resolveContractFunctionReference(fullRef, links, items) {
  const parts = fullRef.split('-');
  const contractName = parts[0];

  // Handle complex function signatures with parameters
  let functionName,
    signature = '';
  if (parts.length > 2) {
    // For complex signatures like SignatureChecker-areValidSignaturesNow-bytes32-bytes[]-bytes[]
    functionName = parts[1];
    // The rest are parameter types - we'll create a simplified signature
    const paramTypes = parts.slice(2);
    if (paramTypes.length > 0) {
      signature = `(${paramTypes.join(', ')})`;
    }
  } else {
    functionName = parts.slice(1).join('-'); // Handle cases like Contract-_private_function
  }

  // First check if this is a local upgradeable contract function
  const upgradeableContractName = contractName + 'Upgradeable';
  const localFunctionKey = `${upgradeableContractName}-${functionName}`;
  const localXrefKey = `xref-${localFunctionKey}`;

  if (links[localXrefKey]) {
    const displayText = signature ? `${contractName}.${functionName}${signature}` : `${contractName}.${functionName}`;
    return `[\`${displayText}\`](${links[localXrefKey]})`;
  }

  // Check if it's a base contract function reference
  if (isBaseContractReference(contractName)) {
    const baseUrl = 'https://docs.openzeppelin.com/contracts/api';
    const category = getSmartContractCategory(contractName, items);
    if (category) {
      // Create anchor for function reference
      let anchor;
      if (functionName === 'constructor') {
        anchor = contractName; // Constructor uses just the contract name as anchor
      } else {
        // For complex signatures, try to create a reasonable anchor
        const cleanFunctionName = functionName.replace(/^_/, '');
        anchor = `${contractName}-${cleanFunctionName}`;
      }
      const displayText = signature
        ? `${contractName}.${functionName}${signature}`
        : functionName === 'constructor'
          ? `${contractName} constructor`
          : `${contractName}.${functionName}`;
      return `[\`${displayText}\`](${baseUrl}/${category}#${anchor})`;
    }
  }

  return null;
}

function isBaseContractReference(name) {
  // Handle contract-function references by extracting just the contract name
  const contractName = name.includes('-') ? name.split('-')[0] : name;

  // Common patterns for base contract interfaces/contracts
  const baseContractPatterns = [
    /^I[A-Z]/, // Interfaces like IAccessControl
    /^ERC\d+/, // Standards like ERC20, ERC721, ERC1967Proxy (without Upgradeable suffix)
    /^[A-Z][a-zA-Z0-9]+$/, // Other base contracts without Upgradeable suffix (including Base64, Create2, CAIP2, etc.)
  ];

  // If it doesn't end with 'Upgradeable', it's likely a base contract
  return !contractName.endsWith('Upgradeable') && baseContractPatterns.some(pattern => pattern.test(contractName));
}

// Legacy function kept for backward compatibility - now uses the new automatic system
// function getContractCategory(name, items) {
//   return getSmartContractCategory(name, items);
// }

function findBestMatch(key, links) {
  let replacement = links[key];

  if (!replacement) {
    // Strategy 1: Look for keys that end with this key
    let matchingKeys = Object.keys(links).filter(linkKey => {
      const parts = linkKey.split('-');
      return parts.length >= 2 && parts[parts.length - 1] === key;
    });

    // Strategy 2: Try with different separators
    if (matchingKeys.length === 0) {
      const keyWithDashes = key.replace(/\./g, '-');
      matchingKeys = Object.keys(links).filter(linkKey => linkKey.includes(keyWithDashes));
    }

    // Strategy 3: Try partial matches
    if (matchingKeys.length === 0) {
      matchingKeys = Object.keys(links).filter(linkKey => {
        return linkKey === key || linkKey.endsWith('-' + key) || linkKey.includes(key);
      });
    }

    if (matchingKeys.length > 0) {
      const nonXrefMatches = matchingKeys.filter(k => !k.startsWith('xref-'));
      const bestMatch = nonXrefMatches.length > 0 ? nonXrefMatches[0] : matchingKeys[0];
      replacement = links[bestMatch];
    }
  }

  return replacement;
}

function cleanupContent(content) {
  return content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x60;/g, '`')
    .replace(/&#x3D;/g, '=')
    .replace(/&amp;/g, '&')
    .replace(/\{(\[`[^`]+`\]\([^)]+\))\}/g, '$1')
    .replace(/https?:\/\/[^\s[]+\[[^\]]+\]/g, match => {
      const urlMatch = match.match(/^(https?:\/\/[^[]+)\[([^\]]+)\]$/);
      return urlMatch ? `[${urlMatch[2]}](${urlMatch[1]})` : match;
    });
}

function processAdocContent(content) {
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adoc-process-'));
    const tempAdocFile = path.join(tempDir, 'temp.adoc');
    const tempMdFile = path.join(tempDir, 'temp.md');

    // Preprocess AsciiDoc content
    let processedContent = content
      .replace(
        /```solidity\s*\ninclude::api:example\$([^[\]]+)\[\]\s*\n```/g,
        "<include cwd lang='solidity'>./examples/$1</include>",
      )
      .replace(
        /\[source,solidity\]\s*\n----\s*\ninclude::api:example\$([^[\]]+)\[\]\s*\n----/g,
        "<include cwd lang='solidity'>./examples/$1</include>",
      )
      .replace(/^(TIP|NOTE):\s*(.+)$/gm, '<Callout>\n$2\n</Callout>')
      .replace(/^(IMPORTANT|WARNING):\s*(.+)$/gm, "<Callout type='warn'>\n$2\n</Callout>");

    fs.writeFileSync(tempAdocFile, processedContent, 'utf8');

    execSync(`bunx downdoc "${tempAdocFile}"`, {
      stdio: 'pipe',
      cwd: process.cwd(),
    });

    let mdContent = fs.readFileSync(tempMdFile, 'utf8');

    // Clean up and transform markdown
    mdContent = cleanupContent(mdContent)
      .replace(/\(api:([^)]+)\.adoc([^)]*)\)/g, '(contracts/v5.x/api/$1.mdx$2)')
      .replace(/!\[([^\]]*)\]\(([^/)][^)]*\.(png|jpg|jpeg|gif|svg|webp))\)/g, '![$1](/$2)')
      .replace(/<dl><dt><strong>💡 TIP<\/strong><\/dt><dd>\s*([\s\S]*?)\s*<\/dd><\/dl>/g, '<Callout>\n$1\n</Callout>')
      .replace(/<dl><dt><strong>📌 NOTE<\/strong><\/dt><dd>\s*([\s\S]*?)\s*<\/dd><\/dl>/g, '<Callout>\n$1\n</Callout>')
      .replace(
        /<dl><dt><strong>(?:💡|📌|ℹ️)?\s*(TIP|NOTE|INFO)<\/strong><\/dt><dd>\s*([\s\S]*?)\s*<\/dd><\/dl>/g,
        '<Callout>\n$2\n</Callout>',
      )
      .replace(/^#+\s+.+$/m, '')
      .replace(/^\n+/, '');

    // Cleanup temp files
    try {
      fs.unlinkSync(tempAdocFile);
      fs.unlinkSync(tempMdFile);
      fs.rmdirSync(tempDir);
    } catch (cleanupError) {
      console.warn('Warning: Could not clean up temp files:', cleanupError.message);
    }

    return mdContent;
  } catch (error) {
    console.warn('Warning: Failed to process AsciiDoc content:', error.message);
    return content;
  }
}

module.exports.title = opts => {
  const pageId = opts.data.root.id;
  const basePath = pageId.replace(/\.(adoc|mdx)$/, '');
  const parts = basePath.split('/');
  const dirName = parts[parts.length - 1] || 'Contracts';
  return dirName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

module.exports.description = opts => {
  const pageId = opts.data.root.id;
  const basePath = pageId.replace(/\.(adoc|mdx)$/, '');
  const parts = basePath.split('/');
  const dirName = parts[parts.length - 1] || 'contracts';
  return `Smart contract ${dirName.replace('-', ' ')} utilities and implementations`;
};

module.exports['with-prelude'] = opts => {
  const currentPage = opts.data.root.id;
  const links = getAllLinks(opts.data.site.items, currentPage);
  const contents = opts.fn();

  return processReferences(contents, links, opts.data.site.items);
};

// ========================================
// AUTOMATIC CONTRACT CATEGORIZATION SYSTEM
// ========================================

// Cache for contract categorization to avoid repeated lookups
const contractCategoryCache = new Map();

/**
 * Automatically determine contract category using path-based detection with intelligent fallbacks
 * This is the main entry point for the robust categorization system
 */
function getSmartContractCategory(contractName, items) {
  // Handle contract-function references by extracting just the contract name
  const cleanContractName = contractName.includes('-') ? contractName.split('-')[0] : contractName;

  // Check cache first
  const cacheKey = `${cleanContractName}:${items?.length || 0}`;
  if (contractCategoryCache.has(cacheKey)) {
    return contractCategoryCache.get(cacheKey);
  }

  let category = null;

  // Approach 1: Path-based categorization (most accurate)
  category = getAutomaticContractCategory(cleanContractName, items);

  // Approach 2: Fallback to intelligent name pattern matching
  if (!category) {
    category = inferCategoryFromName(cleanContractName);
  }

  // Approach 3: Final fallback
  if (!category) {
    category = 'utils';
  }

  // Cache the result
  contractCategoryCache.set(cacheKey, category);
  return category;
}

/**
 * Extract category information directly from contract file paths
 * This uses the actual file organization as the source of truth
 */
function getAutomaticContractCategory(contractName, items) {
  if (!items || !Array.isArray(items)) {
    return null;
  }

  // Find the contract in the items array
  // Try multiple matching strategies to find the right contract
  const contract = items.find(item => {
    if (!item.__item_context?.contract) return false;

    const itemContractName = item.__item_context.contract.name;
    const itemName = item.name;

    // Direct name matches
    if (itemContractName === contractName || itemName === contractName) {
      return true;
    }

    // For base contracts, try matching without 'Upgradeable' suffix
    if (contractName.endsWith('Upgradeable')) {
      const baseName = contractName.replace(/Upgradeable$/, '');
      if (itemContractName === baseName || itemName === baseName) {
        return true;
      }
    }

    // For interfaces, try with and without 'I' prefix
    if (contractName.startsWith('I') && contractName.length > 1) {
      const withoutI = contractName.slice(1);
      if (itemContractName === withoutI || itemName === withoutI) {
        return true;
      }
    }

    return false;
  });

  if (contract && contract.__item_context?.contract?.source?.absolutePath) {
    const contractPath = contract.__item_context.contract.source.absolutePath;
    return extractCategoryFromPath(contractPath);
  }

  // Try alternative path using page context
  if (contract && contract.__item_context?.page) {
    return getCategoryFromPagePath(contract);
  }

  return null;
}

/**
 * Extract category from the contract's file path
 * Maps the directory structure directly to documentation categories
 */
function extractCategoryFromPath(contractPath) {
  // Extract relative path from contracts/...
  // Handle both absolute and relative paths
  const contractsMatch = contractPath.match(/contracts\/([^/]+(?:\/[^/]+)?)/);
  if (!contractsMatch) {
    return null;
  }

  const pathParts = contractsMatch[1].split('/');
  const mainCategory = pathParts[0];
  const subCategory = pathParts[1];

  // Map directory structure to documentation categories
  switch (mainCategory) {
    case 'token':
      if (subCategory) {
        // token/ERC20 -> token/ERC20, token/ERC721 -> token/ERC721, etc.
        return `token/${subCategory}`;
      }
      return 'token';

    case 'utils':
      if (subCategory) {
        // utils/cryptography -> utils/cryptography, etc.
        return `utils/${subCategory}`;
      }
      return 'utils';

    case 'access':
    case 'governance':
    case 'proxy':
    case 'metatx':
    case 'finance':
    case 'account':
      // These map directly to their category names
      return mainCategory;

    default:
      // Unknown directory, return as-is or fallback
      return mainCategory || 'utils';
  }
}

/**
 * Use the generated page paths to determine categories
 * This is a fallback when file path is not available
 */
function getCategoryFromPagePath(item) {
  const pagePath = item.__item_context?.page;
  if (pagePath) {
    // Convert page path like "token/ERC20.mdx" to "token/ERC20"
    const categoryPath = pagePath.replace(/\.(mdx|adoc)$/, '');
    return categoryPath;
  }
  return null;
}

/**
 * Enhanced intelligent name pattern matching
 * Used as a fallback when path information is not available
 */
function inferCategoryFromName(contractName) {
  // Proxy patterns - check ERC1967 before general ERC patterns
  if (/(Proxy|Beacon|Clone|UUPS|Initializable|ERC1967)/.test(contractName)) {
    return 'proxy';
  }

  // Meta-transaction patterns - check ERC2771 before general ERC patterns
  if (/(ERC2771|Forwarder)/.test(contractName)) {
    return 'metatx';
  }

  // ERC Token Standards (most common case)
  if (/^I?ERC\d+/.test(contractName)) {
    if (contractName.includes('20')) return 'token/ERC20';
    if (contractName.includes('721')) return 'token/ERC721';
    if (contractName.includes('1155')) return 'token/ERC1155';
    if (contractName.includes('6909')) return 'token/ERC6909';
    if (contractName.includes('2981')) return 'token/common';
    return 'token';
  }

  // Access Control patterns
  if (/^I?(Access|Authority|Ownable)/.test(contractName)) {
    return 'access';
  }

  // Governance patterns
  if (/^I?(Governor|Timelock|Votes)/.test(contractName)) {
    return 'governance';
  }

  // Cryptography patterns
  if (/(ECDSA|Signature|Hash|Merkle|P256|RSA|EIP712)/.test(contractName)) {
    return 'utils/cryptography';
  }

  // Finance patterns
  if (/(Vesting|Payment|Finance)/.test(contractName)) {
    return 'finance';
  }

  // Account patterns
  if (/(Account|ERC7579|ERC4337)/.test(contractName)) {
    return 'account';
  }

  // Math utilities
  if (/(Math|SafeCast)/.test(contractName)) {
    return 'utils';
  }

  // Data structure patterns
  if (/(BitMaps|Enumerable|DoubleEnded|Checkpoint|Heap|MerkleTree)/.test(contractName)) {
    return 'utils';
  }

  // Default fallback for utilities
  return 'utils';
}

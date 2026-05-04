// ============================================================
//  character-utils.js  —  shared across character.html,
//  dashboard.html, and game.html
//  Include with: <script src="character-utils.js"></script>
// ============================================================

// ── Hair-color name normaliser (handles legacy hex saves) ────
const CHAR_UTILS_HEX_TO_NAME = {
  '#000000': 'black', '#1a1a1a': 'black',
  '#8b4513': 'brown',
  '#daa520': 'blonde',
  '#ff0000': 'red',   '#cc2200': 'red',
  '#ffffff': 'white', '#f0ece4': 'white',
  '#0000ff': 'blue',  '#1155cc': 'blue',
  '#008000': 'green', '#2e7d32': 'green',
  '#ff69b4': 'pink',  '#e91e8c': 'pink',
};

function charUtilsNormaliseColor(color) {
  if (!color) return 'black';
  if (color.startsWith('#')) {
    return CHAR_UTILS_HEX_TO_NAME[color.toLowerCase()] || 'black';
  }
  return color;
}

// ── Resolve all sprite paths for a character object ──────────
//
//  Returns:
//    { body, race, hair, outfit }
//  where race and hair may be null (bald / generic race).
//
function getCharacterSpritePaths(char) {
  const sex   = char.sex   || 'male';
  const race  = char.race  || 'human';
  const outfit = char.outfit || 'rogue';
  const hairStyle = char.hairStyle || 'short';
  const hairColor = charUtilsNormaliseColor(char.hairColor);

  const RACE_SPRITES = {
    elf:        'sprites/race/elf.png',
    dwarf:      'sprites/race/dwarf.png',
    tiefling:   'sprites/race/tiefling.png',
    dragonborn: 'sprites/race/dragonborn.png',
    'half-orc': 'sprites/race/half-orc.png',
  };

  const OUTFIT_FILES = {
    rogue:       'sprites/outfit/rogue.png',
    casual:      'sprites/outfit/casual.png',
    leather:     'sprites/outfit/leather.png',
    plate:       'sprites/outfit/plate.png',
    'mage-robes':'sprites/outfit/mage_robes.png',
  };

  return {
    body:   `sprites/body/${sex}.png`,
    race:   RACE_SPRITES[race] || null,
    hair:   hairStyle === 'bald'
              ? null
              : `sprites/hair/${hairStyle}/${hairStyle}_${hairColor}.png`,
    outfit: OUTFIT_FILES[outfit] || `sprites/outfit/${outfit}.png`,
  };
}

// ── Hair-position offsets (two size sets for the two sprite scales) ─
//
//  scale='large'  → character.html preview  (body 280 px tall)
//  scale='small'  → dashboard.html sidebar  (body 210 px tall)
//
const CHAR_UTILS_HAIR_OFFSETS = {
  large: {
    male: {
      short:    { height: '80px',  marginLeft: '-6px', bottom: '240px' },
      mohawk:   { height: '80px', marginLeft: '-7px', bottom: '230px' },
      braided:  { height: '80px',  marginLeft: '0px',  bottom: '225px' },
      ponytail: { height: '100px', marginLeft: '3px',  bottom: '210px' },
      long:     { height: '110px', marginLeft: '0px',  bottom: '205px' },
    },
    female: {
      short:    { height: '75px',  marginLeft: '-2px', bottom: '240px' },
      mohawk:   { height: '70px', marginLeft: '-3px', bottom: '238px' },
      braided:  { height: '70px',  marginLeft: '2px',  bottom: '230px' },
      ponytail: { height: '100px', marginLeft: '7px',  bottom: '210px' },
      long:     { height: '110px', marginLeft: '0px',  bottom: '205px' },
    },
  },
  small: {
    male: {
      short:    { height: '60px', marginLeft: '-4px', bottom: '175px' },
      mohawk:   { height: '46px', marginLeft: '8px',  bottom: '118px' },
      braided:  { height: '60px', marginLeft: '0px',  bottom: '162px' },
      ponytail: { height: '70px', marginLeft: '1px',  bottom: '158px' },
      long:     { height: '46px', marginLeft: '12px', bottom: '116px' },
    },
    female: {
      short:    { height: '55px', marginLeft: '-2px', bottom: '175px' },
      mohawk:   { height: '46px', marginLeft: '8px',  bottom: '118px' },
      braided:  { height: '55px', marginLeft: '2px',  bottom: '165px' },
      ponytail: { height: '70px', marginLeft: '5px',  bottom: '158px' },
      long:     { height: '46px', marginLeft: '12px', bottom: '116px' },
    },
  },
};

const CHAR_UTILS_HAIR_FALLBACK = {
  large: { height: '110px', marginLeft: '0px', bottom: '210px' },
  small: { height: '42px',  marginLeft: '8px', bottom: '120px' },
};

// ── Load a character from localStorage ───────────────────────
function loadCharacter(username) {
  const raw = localStorage.getItem('dnd_character_' + username);
  if (!raw) return null;
  const c = JSON.parse(raw);
  // normalise legacy hex hair colours on load
  c.hairColor = charUtilsNormaliseColor(c.hairColor);
  return c;
}

// ── Save a character to localStorage ─────────────────────────
function saveCharacter(username, charObj) {
  localStorage.setItem('dnd_character_' + username, JSON.stringify(charObj));
}

// ── Apply a character's sprites to a set of <img> elements ───
//
//  ids = {
//    body:   'db-bodyImg',    // required
//    race:   'db-raceImg',    // required (hidden when no race overlay)
//    hair:   'db-hairImg',    // required
//    outfit: 'db-outfitImg',  // required
//  }
//  scale = 'large' | 'small'
//
function applyCharacterSprites(char, ids, scale) {
  scale = scale || 'small';
  const paths = getCharacterSpritePaths(char);

  // Body
  const bodyEl = document.getElementById(ids.body);
  if (bodyEl) {
    bodyEl.removeAttribute('data-broken');
    bodyEl.src = paths.body;
  }

  // Race overlay
  const raceEl = document.getElementById(ids.race);
  if (raceEl) {
    if (paths.race) {
      raceEl.removeAttribute('data-broken');
      raceEl.src = paths.race;
      raceEl.style.display = 'block';
    } else {
      raceEl.style.display = 'none';
    }
  }

  // Outfit
  const outfitEl = document.getElementById(ids.outfit);
  if (outfitEl) {
    outfitEl.removeAttribute('data-broken');
    outfitEl.src = paths.outfit;
  }

  // Hair
  const hairEl = document.getElementById(ids.hair);
  if (hairEl) {
    if (!paths.hair) {
      hairEl.style.display = 'none';
    } else {
      hairEl.removeAttribute('data-broken');
      hairEl.src = paths.hair;
      hairEl.style.display = 'block';

      const sex       = char.sex       || 'male';
      const hairStyle = char.hairStyle || 'short';
      const scaleSet  = CHAR_UTILS_HAIR_OFFSETS[scale] || CHAR_UTILS_HAIR_OFFSETS.small;
      const sexSet    = scaleSet[sex] || scaleSet.male;
      const o         = sexSet[hairStyle] || CHAR_UTILS_HAIR_FALLBACK[scale];

      hairEl.style.height     = o.height;
      hairEl.style.left       = '50%';
      hairEl.style.marginLeft = o.marginLeft;
      hairEl.style.bottom     = o.bottom;
    }
  }
}

// ── Capitalise first letter ───────────────────────────────────
function charUtilsCap(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}
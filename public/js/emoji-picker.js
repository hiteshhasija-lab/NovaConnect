// A small, dependency-free categorized emoji picker shared by the message reaction "+"
// button and the composer's emoji button — replaces the old fixed 6-emoji QUICK_EMOJI set
// with real categories plus a keyword search, closer to Teams' own picker.
window.createEmojiPicker = function (onPick) {
  const CATEGORIES = [
    { name: 'Smileys', icon: '😀', items: [
      ['😀','grin smile happy'], ['😃','grin smile happy'], ['😄','grin smile happy laugh'], ['😁','grin smile happy'],
      ['😆','laugh happy lol'], ['😅','laugh sweat relief'], ['🤣','rofl lol laugh'], ['😂','joy laugh cry'],
      ['🙂','smile slight'], ['🙃','upside down silly'], ['😉','wink'], ['😊','smile blush happy'],
      ['😇','angel halo innocent'], ['🥰','love hearts adore'], ['😍','love heart eyes'], ['🤩','star eyes excited wow'],
      ['😘','kiss love'], ['😗','kiss'], ['😋','yum tasty tongue'], ['😛','tongue silly'],
      ['😜','wink tongue silly'], ['🤪','crazy silly zany'], ['🤨','skeptical raised eyebrow'], ['🧐','monocle curious'],
      ['🤓','nerd glasses'], ['😎','cool sunglasses'], ['🥳','party celebrate'], ['😏','smirk'],
      ['😒','unamused annoyed'], ['😞','disappointed sad'], ['😔','pensive sad'], ['😟','worried'],
      ['😕','confused'], ['🙁','frown sad'], ['☹️','frown sad'], ['😣','persevere struggle'],
      ['😖','confounded'], ['😫','tired exhausted'], ['😩','weary tired'], ['🥺','pleading puppy eyes'],
      ['😢','cry sad tear'], ['😭','sob cry loud'], ['😤','triumph huff mad'], ['😠','angry mad'],
      ['😡','rage angry mad'], ['🤬','curse swear angry'], ['🤯','mind blown shocked'], ['😳','flushed embarrassed'],
      ['🥵','hot sweating'], ['🥶','cold freezing'], ['😱','scream fear shocked'], ['😨','fearful scared'],
      ['😰','anxious sweat'], ['😥','sad relieved'], ['😓','sweat downcast'], ['🤗','hug'],
      ['🤔','thinking'], ['🤭','giggle oops'], ['🤫','shh quiet'], ['🤥','lying pinocchio'],
      ['😶','no mouth speechless'], ['😐','neutral'], ['😑','expressionless'], ['😬','grimace awkward'],
      ['🙄','eye roll'], ['😯','surprised'], ['😦','frown open mouth'], ['😧','anguished'],
      ['😮','wow surprised open mouth'], ['😲','astonished shocked'], ['🥱','yawn tired bored'], ['😴','sleep zzz'],
      ['🤤','drool'], ['😪','sleepy tired'], ['😵','dizzy'], ['🤐','zipper mouth silent'],
      ['🥴','woozy dizzy'], ['🤢','sick nauseous'], ['🤮','vomit sick'], ['🤧','sneeze sick'],
      ['😷','mask sick'], ['🤒','thermometer sick'], ['🤕','bandage hurt injured']
    ]},
    { name: 'Gestures', icon: '👋', items: [
      ['👋','wave hello bye'], ['🤚','raised hand'], ['🖐️','hand stop'], ['✋','stop hand'],
      ['🖖','vulcan spock'], ['👌','ok okay'], ['🤌','pinched fingers'], ['🤏','pinch small'],
      ['✌️','peace victory'], ['🤞','fingers crossed luck'], ['🤟','love you'], ['🤘','rock on'],
      ['🤙','call me shaka'], ['👈','point left'], ['👉','point right'], ['👆','point up'],
      ['👇','point down'], ['☝️','point up one'], ['👍','thumbsup like yes good'], ['👎','thumbsdown dislike no bad'],
      ['✊','fist power'], ['👊','fist bump punch'], ['🤛','fist bump left'], ['🤜','fist bump right'],
      ['👏','clap applause'], ['🙌','raised hands celebrate'], ['👐','open hands'], ['🤲','open hands offer'],
      ['🤝','handshake deal'], ['🙏','pray thanks please'], ['💪','muscle strong flex'], ['🦾','mechanical arm strong'],
      ['🖕','middle finger'], ['✍️','writing hand'], ['💅','nails manicure'], ['🫡','salute respect']
    ]},
    { name: 'Animals', icon: '🐶', items: [
      ['🐶','dog puppy'], ['🐱','cat kitten'], ['🐭','mouse'], ['🐹','hamster'],
      ['🐰','rabbit bunny'], ['🦊','fox'], ['🐻','bear'], ['🐼','panda'],
      ['🐨','koala'], ['🐯','tiger'], ['🦁','lion'], ['🐮','cow'],
      ['🐷','pig'], ['🐸','frog'], ['🐵','monkey'], ['🐔','chicken'],
      ['🐧','penguin'], ['🐦','bird'], ['🦆','duck'], ['🦉','owl'],
      ['🐺','wolf'], ['🐗','boar'], ['🐴','horse'], ['🦄','unicorn'],
      ['🐝','bee'], ['🐛','bug caterpillar'], ['🦋','butterfly'], ['🐌','snail'],
      ['🐢','turtle'], ['🐍','snake'], ['🐙','octopus'], ['🦈','shark'],
      ['🐬','dolphin'], ['🐳','whale'], ['🐊','crocodile'], ['🦓','zebra'],
      ['🦒','giraffe'], ['🐘','elephant'], ['🦘','kangaroo'], ['🐕','dog'],
      ['🐈','cat'], ['🐓','rooster'], ['🦅','eagle'], ['🦇','bat']
    ]},
    { name: 'Food', icon: '🍕', items: [
      ['🍏','apple green'], ['🍎','apple red'], ['🍌','banana'], ['🍇','grapes'],
      ['🍓','strawberry'], ['🍒','cherry'], ['🍑','peach'], ['🍍','pineapple'],
      ['🥝','kiwi'], ['🍅','tomato'], ['🥑','avocado'], ['🌽','corn'],
      ['🥕','carrot'], ['🍞','bread'], ['🧀','cheese'], ['🥚','egg'],
      ['🍳','fried egg cooking'], ['🥓','bacon'], ['🍔','burger'], ['🍟','fries'],
      ['🍕','pizza'], ['🌭','hotdog'], ['🥪','sandwich'], ['🌮','taco'],
      ['🌯','burrito'], ['🍜','ramen noodles'], ['🍣','sushi'], ['🍱','bento'],
      ['🍩','donut'], ['🍪','cookie'], ['🎂','cake birthday'], ['🍰','cake slice'],
      ['🍫','chocolate'], ['🍿','popcorn'], ['🍺','beer'], ['🍻','cheers beer'],
      ['🍷','wine'], ['🍸','cocktail'], ['☕','coffee'], ['🍵','tea'],
      ['🥤','drink soda'], ['🍦','ice cream'], ['🍭','lollipop candy']
    ]},
    { name: 'Activities', icon: '⚽', items: [
      ['⚽','soccer football'], ['🏀','basketball'], ['🏈','american football'], ['⚾','baseball'],
      ['🎾','tennis'], ['🏐','volleyball'], ['🏉','rugby'], ['🎱','pool billiards'],
      ['🏓','ping pong'], ['🏸','badminton'], ['🥊','boxing'], ['🥋','martial arts'],
      ['⛳','golf'], ['🏹','archery'], ['🎣','fishing'], ['🥏','frisbee'],
      ['🛹','skateboard'], ['🏂','snowboard'], ['⛷️','ski'], ['🏄','surf'],
      ['🏊','swim'], ['🚴','cycling'], ['🏋️','weightlifting gym'], ['🤸','cartwheel gymnastics'],
      ['🎯','dart target bullseye'], ['🎮','video game'], ['🎲','dice game'], ['♟️','chess'],
      ['🎨','art paint'], ['🎭','theater drama'], ['🎤','mic karaoke sing'], ['🎧','headphones music'],
      ['🎸','guitar music'], ['🥁','drums music'], ['🎹','piano music'], ['🏆','trophy win'],
      ['🥇','gold medal first'], ['🎉','party celebrate confetti'], ['🎊','tada confetti celebrate']
    ]},
    { name: 'Travel', icon: '✈️', items: [
      ['🚗','car'], ['🚕','taxi'], ['🚌','bus'], ['🚓','police car'],
      ['🚑','ambulance'], ['🚒','fire truck'], ['🚚','truck'], ['🚲','bike bicycle'],
      ['🛵','scooter'], ['🏍️','motorcycle'], ['🚆','train'], ['🚄','bullet train'],
      ['🚢','ship boat'], ['⛵','sailboat'], ['🚀','rocket space'], ['✈️','plane flight'],
      ['🛫','plane departure'], ['🛬','plane arrival'], ['🚁','helicopter'], ['🗽','statue liberty'],
      ['🗼','tower'], ['🏰','castle'], ['🏔️','mountain'], ['🏖️','beach'],
      ['🏝️','island'], ['🌋','volcano'], ['🏕️','camping tent'], ['🏙️','city skyline'],
      ['🌉','bridge'], ['🌅','sunrise'], ['🌇','sunset'], ['🌃','night city'],
      ['🎡','ferris wheel'], ['🎢','roller coaster'], ['🗺️','map'], ['🧳','luggage suitcase travel']
    ]},
    { name: 'Objects', icon: '💡', items: [
      ['💡','idea bulb light'], ['🔦','flashlight'], ['📱','phone mobile'], ['💻','laptop computer'],
      ['⌨️','keyboard'], ['🖥️','desktop computer'], ['🖨️','printer'], ['🖱️','mouse computer'],
      ['📷','camera photo'], ['🎥','video camera film'], ['📺','tv television'], ['📻','radio'],
      ['⏰','alarm clock'], ['⌚','watch time'], ['📅','calendar date'], ['📆','calendar'],
      ['📎','paperclip attach'], ['📌','pin location'], ['📍','pin location map'], ['✂️','scissors cut'],
      ['🔒','lock secure'], ['🔓','unlock'], ['🔑','key'], ['🔨','hammer tool'],
      ['🛠️','tools wrench'], ['🔧','wrench tool'], ['💰','money bag'], ['💵','money dollar cash'],
      ['💳','credit card'], ['📦','package box'], ['📧','email mail'], ['📨','envelope mail'],
      ['📝','memo note write'], ['📁','folder file'], ['📊','chart bar graph'], ['📈','chart up trending'],
      ['📉','chart down trending'], ['🔍','search magnify'], ['🔔','bell notification'], ['🔕','mute bell']
    ]},
    { name: 'Symbols', icon: '❤️', items: [
      ['❤️','heart love red'], ['🧡','heart orange'], ['💛','heart yellow'], ['💚','heart green'],
      ['💙','heart blue'], ['💜','heart purple'], ['🖤','heart black'], ['🤍','heart white'],
      ['🤎','heart brown'], ['💔','heart broken sad'], ['❣️','heart exclaim'], ['💕','hearts love'],
      ['💞','hearts revolving love'], ['💓','heartbeat love'], ['💗','heart growing love'], ['💖','sparkling heart love'],
      ['💘','heart arrow love'], ['💝','heart gift love'], ['✅','check yes done'], ['❌','x no cross'],
      ['❓','question mark'], ['❗','exclamation mark'], ['⚠️','warning caution'], ['🚫','no forbidden'],
      ['♻️','recycle'], ['🔥','fire hot lit'], ['⭐','star'], ['🌟','star sparkle'],
      ['✨','sparkles shiny'], ['⚡','lightning bolt energy'], ['💯','hundred perfect'], ['💤','sleep zzz'],
      ['💬','speech bubble chat'], ['🗨️','speech bubble'], ['💭','thought bubble think'], ['🕐','clock time']
    ]}
  ];

  let panel = null, outsideHandler = null, keyHandler = null;

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', outsideHandler);
    document.removeEventListener('keydown', keyHandler);
  }

  function renderGrid(grid, items) {
    grid.replaceChildren();
    if (!items.length) { grid.innerHTML = '<p class="emoji-picker-empty">No matching emoji.</p>'; return; }
    items.forEach(([e]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = e; b.title = e;
      b.onclick = () => { onPick(e); close(); };
      grid.appendChild(b);
    });
  }

  let currentAnchor = null;
  function open(anchorEl) {
    if (panel) { const same = currentAnchor === anchorEl; close(); if (same) return; }
    currentAnchor = anchorEl;
    panel = document.createElement('div');
    panel.className = 'emoji-picker-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose an emoji');
    panel.innerHTML =
      '<input type="search" class="emoji-picker-search" placeholder="Search emoji" aria-label="Search emoji">' +
      '<div class="emoji-picker-tabs" role="tablist"></div>' +
      '<div class="emoji-picker-grid"></div>';
    document.body.appendChild(panel);

    const tabs = panel.querySelector('.emoji-picker-tabs');
    const grid = panel.querySelector('.emoji-picker-grid');
    const search = panel.querySelector('.emoji-picker-search');
    let activeCat = 0;

    CATEGORIES.forEach((c, i) => {
      const t = document.createElement('button');
      t.type = 'button'; t.textContent = c.icon; t.title = c.name;
      t.className = i === 0 ? 'active' : ''; t.setAttribute('role', 'tab');
      t.onclick = () => { activeCat = i; tabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === t)); search.value = ''; renderGrid(grid, c.items); };
      tabs.appendChild(t);
    });
    renderGrid(grid, CATEGORIES[0].items);

    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      if (!q) { renderGrid(grid, CATEGORIES[activeCat].items); return; }
      const all = CATEGORIES.flatMap(c => c.items);
      renderGrid(grid, all.filter(([e, k]) => k.includes(q)));
    };

    const rect = anchorEl.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      let left = Math.min(rect.left, window.innerWidth - pw - 8);
      let top = rect.top - ph - 8;
      if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - ph - 8);
      panel.style.left = Math.max(8, left) + 'px';
      panel.style.top = Math.max(8, top) + 'px';
      panel.style.visibility = 'visible';
    });

    outsideHandler = (e) => { if (panel && !panel.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close(); };
    keyHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outsideHandler);
    document.addEventListener('keydown', keyHandler);
  }

  return { open, close };
};

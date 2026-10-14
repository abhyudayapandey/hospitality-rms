// The website (ADR 141): app screens, the menu, the plan builder (/plans) and the demo form
// (/demo). Each page is its own HTML file (build.ts); nothing here routes.
// No inline script anywhere, so the site's CSP is script-src 'self'.
(function () {
  var nav = function (on) {
    return (
      '<div class="nav">' +
      ['Home', 'To do', 'Stock', 'Roster', 'Me']
        .map(function (n) {
          return '<span' + (n === on ? ' class="on"' : '') + '>' + n + '</span>';
        })
        .join('') +
      '</div>'
    );
  };
  var shell = function (title, sub, body, on) {
    return (
      '<div class="status"><span>09:41</span><span>4G ▮▮▮</span></div>' +
      '<div class="top"><b>' +
      title +
      '</b><span>' +
      sub +
      '</span></div>' +
      '<div class="body">' +
      body +
      '</div>' +
      nav(on)
    );
  };
  var senior = function (text, acts) {
    return (
      '<div class="card sr"><div class="srh"><svg aria-hidden="true"><use href="#sr-mark"/></svg>Senior</div><span>' +
      text +
      '</span>' +
      (acts
        ? '<div class="row2"><div class="abtn">' +
          acts[0] +
          '</div><div class="abtn line">' +
          acts[1] +
          '</div></div>'
        : '') +
      '</div>'
    );
  };
  var item = function (img, name, have, par, pill) {
    return (
      '<div class="li"><img class="thumb" src="img/' +
      img +
      '.webp" alt=""><div class="t"><b>' +
      name +
      '</b><span>par ' +
      par +
      '</span></div>' +
      (pill ? '<span class="pill">' + pill + '</span>' : '') +
      '<div class="qty">' +
      have +
      '<i>here</i></div></div>'
    );
  };
  var PHONES = {
    home: shell(
      'Good morning',
      'Seaside Hotel · GM',
      senior('Paneer is low at the Kitchen Store. Order 5 kg from Shree Dairy for tomorrow?', [
        'Yes, order',
        'Not now',
      ]) +
        '<div class="card"><h5>Do these first</h5>' +
        '<div class="li"><div class="ic">✓</div><div class="t"><b>Approve supply request</b><span>Kitchen · waiting for approval</span></div><span class="chev">›</span></div>' +
        '<div class="li"><div class="ic amber">#</div><div class="t"><b>Stock check due</b><span>Bar · today</span></div><span class="chev">›</span></div>' +
        '<div class="li"><div class="ic red">2</div><div class="t"><b>Not in yet</b><span>Evening shift · 18:00</span></div><span class="chev">›</span></div></div>' +
        '<div class="card"><h5>Today so far</h5><div class="nums">' +
        '<div class="num"><b>₹1,84,200</b><span>Sales</span></div><div class="num"><b>212</b><span>Covers</span></div></div></div>',
      'Home',
    ),
    stock: shell(
      'Stock',
      'Kitchen Store',
      '<div class="tabs"><span>All</span><span class="on">Running low 6</span><span>Expiring 2</span><span>More</span></div>' +
        '<div class="card">' +
        item('tomato', 'Tomato', '4.5 kg', '12 kg', 'Low') +
        item('onion', 'Onion', '6 kg', '20 kg', 'Low') +
        item('paneer', 'Paneer', '2 kg', '5 kg', 'Low') +
        item('cream', 'Fresh cream', '1.5 L', '4 L', 'Low') +
        item('lime', 'Lime', '40 nos', '120 nos', 'Low') +
        '</div>' +
        '<div class="abtn">Fill all 6 short items up to par</div>',
      'Stock',
    ),
    shift: shell(
      'Your shift',
      'Tue 14 Oct · Bar',
      '<div class="card"><div class="li"><div class="t"><b class="b13">18:00 – 02:00</b><span>Bar · Steward · late shift</span></div><span class="pill ok">On site</span></div>' +
        '<div class="abtn">Clock in with a selfie</div></div>' +
        senior('Ravi is 10 minutes late. Call him, or give his checklist to Imran?', [
          'Give to Imran',
          'Wait',
        ]) +
        '<div class="card"><h5>To do list</h5>' +
        '<div class="li"><div class="ic">☰</div><div class="t"><b>Bar opening checklist</b><span>7 steps · due 18:30</span></div><span class="chev">›</span></div>' +
        '<div class="li"><div class="ic">#</div><div class="t"><b>Count: Bar store</b><span>In shelf order · due 19:00</span></div><span class="chev">›</span></div></div>',
      'Roster',
    ),
    prep: shell(
      'Makhani gravy',
      'Prep task · Kitchen · 4 L',
      senior('This is the house recipe, scaled to 4 litres. Step pictures are below.') +
        '<div class="card"><h5>Ingredients for 4 L</h5>' +
        '<div class="li"><img class="thumb" src="img/tomato.webp" alt=""><div class="t"><b>Tomato</b></div><div class="qty">3.2 kg</div></div>' +
        '<div class="li"><img class="thumb" src="img/butter.webp" alt=""><div class="t"><b>Butter</b></div><div class="qty">400 g</div></div>' +
        '<div class="li"><img class="thumb" src="img/cream.webp" alt=""><div class="t"><b>Fresh cream</b></div><div class="qty">600 ml</div></div>' +
        '<div class="li"><img class="thumb" src="img/onion.webp" alt=""><div class="t"><b>Onion</b></div><div class="qty">800 g</div></div></div>' +
        '<div class="abtn">Done · print label</div>',
      'To do',
    ),
    check: shell(
      'Kitchen closing',
      'Checklist · 5 of 7 done',
      '<div class="card"><div class="steps">' +
        '<div class="step"><span class="box done"></span>Walk-in chiller below 5 °C</div>' +
        '<div class="step"><span class="box done"></span>Label and date open containers</div>' +
        '<div class="step"><span class="box done"></span>Gas valves off</div>' +
        '<div class="step"><span class="box done"></span>Floor and drains cleaned</div>' +
        '<div class="step"><span class="box done"></span>Waste out, bins washed</div>' +
        '<div class="step"><span class="box"></span>Photo of the range, clean</div>' +
        '<div class="step"><span class="box"></span>Handover note for the morning</div></div></div>' +
        senior('2 steps left. The morning team will see your note on their Home.') +
        '<div class="abtn line">Add a photo</div>',
      'To do',
    ),
    minibar: shell(
      'Room 214',
      'Minibar check · Housekeeping',
      '<div class="card"><h5>What is missing?</h5>' +
        '<div class="li"><div class="ic">2</div><div class="t"><b>Soda 300 ml</b><span>par 4 · ₹90 each</span></div><div class="qty">₹180</div></div>' +
        '<div class="li"><div class="ic">1</div><div class="t"><b>Salted cashews</b><span>par 2 · ₹250 each</span></div><div class="qty">₹250</div></div>' +
        '<div class="li"><div class="ic dim">0</div><div class="t"><b>Water 1 L</b><span>par 2</span></div><div class="qty">–</div></div></div>' +
        '<div class="card"><div class="li"><div class="t"><b>Charge to room</b><span>Bill goes to the front desk on shift</span></div><div class="qty q13">₹430</div></div></div>' +
        '<div class="abtn">Save · refill goes to my To do list</div>',
      'To do',
    ),
    licence: shell(
      'Good morning',
      'Seaside Hotel · GM',
      '<div class="card warn"><h5>Compliance</h5><div class="li"><div class="ic amber">!</div><div class="t"><b>FSSAI licence</b><span>Expires in 90 days</span></div></div>' +
        '<div class="li"><div class="ic amber">!</div><div class="t"><b>Pest control</b><span>Due in 14 days</span></div></div></div>' +
        senior('The FSSAI renewal is with you. Upload the new licence here when it comes.', [
          'Open',
          'Later',
        ]) +
        '<div class="card"><h5>All clear</h5><div class="li"><div class="ic">✓</div><div class="t"><b>Fire extinguishers</b><span>Checked 3 Oct</span></div></div></div>',
      'Home',
    ),
  };
  document.querySelectorAll('[data-phone]').forEach(function (el) {
    el.innerHTML = PHONES[el.getAttribute('data-phone')] || '';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'A screen from the Senior app');
  });

  var menu = document.getElementById('menu');
  var burger = document.getElementById('burger');
  burger.addEventListener('click', function () {
    var open = menu.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Plan builder: bundles and their blocks, as in packages/domain bundles.ts and modules.ts.
  var BUNDLES = [
    {
      code: 'stock_buying',
      name: 'Stock that adds up',
      adds: 'Stores and stock, stock checks and requests, wastage, and buying from suppliers.',
      mods: ['Stores & stock', 'Supply requests & orders', 'Breakage', 'Shelf life & labels'],
    },
    {
      code: 'kitchen_bar',
      name: 'Recipes that stay',
      adds: 'Recipes and costing, production and prep lists, the menu and sales, excise.',
      mods: ['Recipes & costing', 'Production', 'Prep lists', 'Menu and sales', 'Excise'],
    },
    {
      code: 'people',
      name: 'The roster',
      adds: 'The roster, clock-in, salaries and labour cost, leave and shift swaps, training.',
      mods: [
        'Roster',
        'Clock-in',
        'Salaries & labour cost',
        'Leave',
        'Shift swaps',
        'Training & SOPs',
      ],
    },
    {
      code: 'daily_work',
      name: "Every role's day",
      adds: "Checklists, repairs, today's briefing, logbook, registers, meters and audits.",
      mods: [
        'Checklists',
        'Maintenance',
        "Today's briefing",
        'Logbook & handover',
        'Registers',
        'Utilities',
        'Audits & taste panels',
      ],
    },
    {
      code: 'hotel',
      name: 'Hotel rooms',
      adds: 'Room minibars, rooms, linen and uniforms.',
      mods: ['Room minibars', 'Rooms', 'Linen & uniforms'],
    },
    {
      code: 'events_compliance',
      name: 'Licences & events',
      adds: 'Events, and the licence register with the compliance calendar.',
      mods: ['Events', 'Compliance'],
    },
  ];
  var USUAL = {
    hotel: ['stock_buying', 'kitchen_bar', 'people', 'daily_work', 'hotel', 'events_compliance'],
    bar: ['stock_buying', 'kitchen_bar', 'people', 'daily_work', 'events_compliance'],
    restaurant: ['stock_buying', 'kitchen_bar', 'people', 'daily_work', 'events_compliance'],
    qsr: ['stock_buying', 'kitchen_bar', 'people', 'daily_work'],
    cloud: ['stock_buying', 'kitchen_bar', 'people', 'daily_work'],
  };
  // only on /plans
  var wrap = document.getElementById('bcards');
  if (wrap) {
    wrap.innerHTML = BUNDLES.map(function (b) {
      return (
        '<label class="bcard"><input type="checkbox" id="b-' +
        b.code +
        '" value="' +
        b.code +
        '"><h3>' +
        b.name +
        '</h3><p>' +
        b.adds +
        '</p>' +
        '<span class="price">' +
        b.mods.length +
        ' jobs · Talk to us</span></label>'
      );
    }).join('');
    function sum() {
      var on = BUNDLES.filter(function (b) {
        return document.getElementById('b-' + b.code).checked;
      });
      var mods = on.reduce(function (a, b) {
        return a.concat(b.mods);
      }, []);
      document.getElementById('sumCount').textContent = mods.length;
      document.getElementById('sumList').innerHTML = mods.length
        ? mods
            .map(function (m) {
              return '<li>' + m + '</li>';
            })
            .join('')
        : '<li>Only the basics</li>';
    }
    function pick(fmt) {
      document.querySelectorAll('.fmt button').forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.fmt === fmt ? 'true' : 'false');
      });
      BUNDLES.forEach(function (b) {
        document.getElementById('b-' + b.code).checked = USUAL[fmt].indexOf(b.code) >= 0;
      });
      sum();
    }
    document.querySelectorAll('.fmt button').forEach(function (b) {
      b.addEventListener('click', function () {
        pick(b.dataset.fmt);
      });
    });
    wrap.addEventListener('change', sum);
    pick('bar');
  }

  // Demo form: checks the three fields here, then sends them to /api/demo-request (the app,
  // through this site's own origin; ADR 141). Thanks only once the request is stored.
  // only on /demo
  var form = document.getElementById('demoForm');
  if (form) {
    var err = document.getElementById('formErr');
    var send = document.getElementById('f-send');
    var MESSAGES = {
      RATE_LIMITED: 'Too many requests from here. Please try again in an hour.',
      INVALID: 'Please check your name, phone number and business name.',
    };
    function fail(text) {
      err.textContent = text;
      err.hidden = false;
      send.disabled = false;
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {
        name: form.name.value.trim(),
        phone: form.phone.value.trim(),
        email: form.email.value.trim(),
        business: form.business.value.trim(),
        outletKind: form.type.value,
        outlets: form.outlets.value,
        website: form.website.value,
      };
      if (!data.name || data.phone.replace(/\D/g, '').length < 10 || !data.business) {
        fail('Add your name, phone number and business name.');
        return;
      }
      err.hidden = true;
      send.disabled = true;
      fetch('/api/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!res.ok) {
                fail(MESSAGES[body.code] || 'That did not go through. Please try again.');
                return;
              }
              document.getElementById('tName').textContent = data.name.split(' ')[0];
              document.getElementById('tPhone').textContent = data.phone;
              form.hidden = true;
              document.getElementById('thanks').hidden = false;
            });
        })
        .catch(function () {
          fail('No connection. Please try again when you are online.');
        });
    });
  }
})();

// Meltado 2026 menu. Prices in ₹ (menu estimate; final bill comes from the POS).
// To change the menu, edit this file only.
(function () {
  const COFFEE_ADDONS = {
    id: "addons", label: "Add-ons", type: "multi", required: false,
    choices: [
      { name: "Whipped cream", price: 50 },
      { name: "Extra espresso shot", price: 50 },
      { name: "Extra ice cream scoop", price: 50 },
      { name: "Almond milk", price: 100 },
    ],
  };
  const HOT_FLAVOUR = {
    id: "flavour", label: "Flavour (optional)", type: "single", required: false,
    choices: ["Irish", "Hazelnut", "Vanilla", "Caramel", "Cookies n' Crème"].map((n) => ({ name: n, price: 30 })),
  };
  const SIDE = {
    id: "side", label: "Side", type: "single", required: true,
    choices: [{ name: "Fries", price: 0 }, { name: "Potato Wedges", price: 0 }, { name: "Nachos", price: 0 }],
  };
  const MELTING_CHEESE = {
    id: "cheese", label: "Extra", type: "multi", required: false,
    choices: [{ name: "Melting cheese", price: 40 }],
  };
  const pick = (id, label, names) => ({
    id, label, type: "single", required: true, choices: names.map((n) => ({ name: n, price: 0 })),
  });

  const W = true; // served with whipped cream
  const it = (name, price, extra = {}) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    name, price, ...extra,
  });

  window.MENU = [
    {
      id: "cold-coffee", name: "Cold Coffee", group: "Coffee",
      items: [
        it("Classic", 160), it("Vanilla Crème", 190), it("Hazelnut", 190), it("Irish Crème", 190),
        it("Caramel", 190),
        it("Betterscotch", 190, { aliases: ["butterscotch"], options: [pick("style", "Style", ["Regular", "Crumble"])] }),
        it("Cookies n' Crème", 190), it("Café Mocha (Cold)", 200, { whipped: W }),
        it("Javachip", 220, { whipped: W }), it("Nutella Krisper", 220, { whipped: W }),
        it("Vanilla Cookie Crumble", 220, { whipped: W }), it("Chocolate Cookie Crumble", 220, { whipped: W }),
        it("Caramel Drizzle Javachip", 240, { whipped: W }),
      ].map((x) => ({ ...x, options: [...(x.options || []), COFFEE_ADDONS] })),
    },
    {
      id: "iced", name: "Iced", group: "Coffee",
      items: [
        it("Iced Americano", 160), it("Citrus Iced Americano", 170),
        it("Iced Latte / Cappuccino", 170, { options: [pick("type", "Type", ["Latte", "Cappuccino"])] }),
        it("Iced Mocha Latte / Cappuccino", 200, { options: [pick("type", "Type", ["Latte", "Cappuccino"])] }),
      ].map((x) => ({ ...x, options: [...(x.options || []), COFFEE_ADDONS] })),
    },
    {
      id: "hot", name: "Hot", group: "Coffee",
      items: [
        it("Espresso (30 ml)", 100), it("Americano (Black Coffee)", 140), it("Café Latte", 160),
        it("Cappuccino", 160), it("Café Mocha", 190), it("Cocochino", 190),
        it("Hot Chocolate (44.6% Dark)", 220),
      ].map((x) => ({ ...x, options: [HOT_FLAVOUR, COFFEE_ADDONS] })),
    },
    {
      id: "ice-tea", name: "Ice Tea", group: "Coffee-free",
      items: [it("Lemon Ice Tea", 160), it("Peach Ice Tea", 160), it("Strawberry Ice Tea", 180), it("Watermelon Ice Tea", 180)],
    },
    {
      id: "refreshers", name: "Refreshers", group: "Coffee-free",
      items: [
        it("Pink Lemonade", 160), it("Lemon Mint Mojito", 160), it("Watermelon Mint Mojito", 180),
        it("Mango Mint Mojito", 180), it("Kiwi Mint Mojito", 180), it("Blueberry Mint Mojito", 180),
        it("Strawberry Mint Mojito", 180), it("Pina Colada", 200),
      ],
    },
    {
      id: "shakes", name: "Smooth Shakes", group: "Coffee-free",
      items: [
        it("Vanilla Crème Frappe", 200), it("Strawberry Crème Frappe", 200),
        it("Belgian Chocolate", 200, { options: [pick("choc", "Chocolate", ["Dark", "Regular"])] }),
        it("Cookie Crumble Frappe", 200), it("Brownie Fudge Frappe", 200), it("Choco Mint Frappe", 200),
        it("Blueberry Frappe", 200), it("Sea Salted Caramel Frappe", 200), it("Bubblegum Frappe", 220),
        it("Mixedberry Frappe", 220), it("Vanilla Mint Frappe", 220), it("Tropical Coconut Frappe", 220),
        it("Peanut Butter Chocolate", 220), it("Nutella Frappe Lotus", 240), it("Biscoff Frappe", 240),
      ].map((x) => ({ ...x, whipped: W })),
    },
    {
      id: "savouries", name: "Savouries", group: "Food",
      items: [
        it("Salted Fries", 150), it("Peri Peri Fries", 160), it("Potato Wedges", 180), it("Half n' Half", 180),
        it("Cheesy Loaded Fries", 220), it("Cheesy Loaded Nachos", 220), it("Cheesy Mozzarella Sticks", 220),
        it("Cheesy Loaded Wedges", 220), it("Cigar Rolls", 240),
      ],
    },
    {
      id: "wraps", name: "Wraps", group: "Food", note: "Served with a side of Fries / Potato Wedges / Nachos",
      items: [
        it("Falafel and Hummus Wrap", 250, { desc: "Crispy falafel, in-house hummus, pickled onions, iceberg lettuce, jalapeños" }),
        it("Cottage Cheese and Cream Onion Wrap", 250, { desc: "Deep fried paneer patty, creamy onions, herb spread" }),
        it("Indi Paneer Wrap", 250, { desc: "Sautéed paneer, onions, chillies & peppers, mint sauce, pickled onions, lettuce" }),
      ].map((x) => ({ ...x, options: [SIDE] })),
    },
    {
      id: "quesadilla", name: "Quesadilla", group: "Food", note: "Served with a side of Fries / Potato Wedges / Nachos",
      items: [
        it("Pizza Quesadilla", 200, { desc: "Mozzarella & cheddar, in-house marinara, fresh basil" }),
        it("The Pesto Melt Quesadilla", 220, { desc: "Mozzarella & cheddar, in-house pesto, fresh basil" }),
        it("The Garden Fresh Quesadilla", 220, { desc: "Fresh vegetables, marinara, mozzarella" }),
      ].map((x) => ({ ...x, options: [SIDE] })),
    },
    {
      id: "panini", name: "Panini", group: "Food", note: "Served with a side of Fries / Potato Wedges / Nachos",
      items: [
        it("Aloo Crunch Panini", 240, { desc: "Aloo patty, iceberg lettuce, pickled onion, mint mayo" }),
        it("Grilled Vegetables Panini", 240, { desc: "Grilled peppers, mushrooms, baby corn, broccoli, garlic aioli" }),
        it("Spinach n' Corn", 240, { desc: "Garlic spinach, American corn, mozzarella, herb spread" }),
        it("Spinach Mushroom Panini", 240, { desc: "Garlic spinach, sautéed mushrooms, mozzarella, herb spread" }),
        it("Cheese and Corn Panini", 240, { desc: "Sweet corn, in-house cheese spread, mozzarella" }),
        it("The Three Cheese Panini", 240, { desc: "Mozzarella, American cheddar, in-house cheese spread" }),
        it("Cheesy Mushroom Panini", 260, { desc: "Sautéed mushrooms, caramelised onions, cream sauce, garlic aioli" }),
        it("Spicy Paneer Panini", 260, { desc: "Spicy paneer patty, lettuce, pickled onion, mint mayo, hot sauce" }),
      ].map((x) => ({ ...x, options: [SIDE, MELTING_CHEESE] })),
    },
    {
      id: "mac", name: "Mac and Cheese", group: "Food",
      items: [
        it("The Three Cheese Mac", 270, { desc: "In-house cheese sauce, American cheddar, mozzarella" }),
        it("Cheetos Flamin' Hot Mac", 270, { desc: "In-house special spice blend" }),
        it("Crushed Nachos Mac", 270, { desc: "Cheesy blend topped with crushed nachos" }),
        it("Chilli Garlic Mac", 270, { desc: "Spicy chilli sauce with garlic" }),
        it("Creamy Pesto Mac", 270, { desc: "Creamy mac n' cheese with pesto" }),
        it("Mushroom & Corn Mac", 270),
      ],
    },
    {
      id: "korean-buns", name: "Korean Buns", group: "Food",
      items: [
        it("Classic Korean Cream Cheese Bun", 220, { desc: "Brioche, herbed cream cheese, garlic herb butter, mozzarella" }),
        it("Pesto Korean Cream Cheese Bun", 220),
        it("Peri Peri Korean Cream Cheese Bun", 220),
      ],
    },
    {
      id: "desserts", name: "Desserts", group: "Desserts",
      items: [
        it("Chocolate Storm", 180), it("Belgian Chocolate Slice", 180), it("Triple Layered Moussecake", 200),
        it("German Chocolate", 200),
        it("Cheesecake Slice", 220, { options: [pick("flavour", "Flavour", ["Strawberry", "Blueberry"])] }),
        it("Tiramisu", 240), it("Banoffee With Oatmeal Crumble", 240), it("Biscoff Cheesecake Slice", 240),
        it("Choco Crunch", 240), it("Meltado's Creamy Fruit Salad", 240, { desc: "With honey almond sponge" }),
      ],
    },
  ];
})();

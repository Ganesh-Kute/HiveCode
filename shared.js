// shared.js — used for the Hivecode coordination + merge test.
// Two independent functions so two agents can edit different parts.

function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };

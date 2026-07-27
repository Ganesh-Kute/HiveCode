export function calculateTotal(price, tax) {
  return price + (price * tax);
}
export function processCart(cart) {
  return calculateTotal(cart.price, 0.2);
}

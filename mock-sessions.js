// mock-sessions.js
// 按 productId 存假数据；先只配你这个演出商品
// 价格单位就先用“元”（929），以后接真接口再统一改成“分”也可以

const mockSessionsByProduct = {
  // 替换成你自己的商品 id，这里先用你给的示例
  '1849043029623820': [
    // 2025-12-31 20:00
    { session: '2025-12-31 20:00', area: 'A区', price: 929, remainStock: 7, totalStock: 7 },
    { session: '2025-12-31 20:00', area: 'B区', price: 835, remainStock: 4, totalStock: 4 },
    { session: '2025-12-31 20:00', area: 'C区', price: 647, remainStock: 7, totalStock: 7 },
    { session: '2025-12-31 20:00', area: 'D区', price: 553, remainStock: 7, totalStock: 7 },
    { session: '2025-12-31 20:00', area: 'E区', price: 459, remainStock: 5, totalStock: 5 },

    // 2026-01-01 20:00
    { session: '2026-01-01 20:00', area: 'A区', price: 929, remainStock: 7, totalStock: 7 },
    { session: '2026-01-01 20:00', area: 'B区', price: 835, remainStock: 4, totalStock: 4 },
    { session: '2026-01-01 20:00', area: 'D区', price: 553, remainStock: 7, totalStock: 7 },
    { session: '2026-01-01 20:00', area: 'E区', price: 459, remainStock: 7, totalStock: 7 },

    // 2026-01-02 20:00
    { session: '2026-01-02 20:00', area: 'A区', price: 929, remainStock: 7, totalStock: 7 },
    { session: '2026-01-02 20:00', area: 'B区', price: 835, remainStock: 4, totalStock: 4 },
    { session: '2026-01-02 20:00', area: 'D区', price: 553, remainStock: 7, totalStock: 7 },
    { session: '2026-01-02 20:00', area: 'E区', price: 459, remainStock: 2, totalStock: 3 },
  ],
};

function getMockSessions(productId) {
  return mockSessionsByProduct[productId] || [];
}

module.exports = { getMockSessions };

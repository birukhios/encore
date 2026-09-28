// The pages each role can open. The server keeps the same list (StaffService.RolePages) and enforces it.
export const ROLE_PAGES = {
  Owner: ['Overview', 'Events', 'Bookings', 'Check-ins', 'Reports', 'Tables', 'Menu', 'Stock', 'Waiters', 'Orders', 'Team', 'Settings', 'Guide'],
  Admin: ['Overview', 'Events', 'Bookings', 'Check-ins', 'Reports', 'Tables', 'Menu', 'Stock', 'Waiters', 'Orders', 'Team', 'Settings', 'Guide'],
  Service: ['Overview', 'Orders', 'Guide'],
  Cashier: ['Orders', 'Guide'],
  Gate: ['Overview', 'Bookings', 'Check-ins', 'Guide'],
};

export const ROLE_LABELS = { Service: 'Cashier & service', Cashier: 'Cashier' };

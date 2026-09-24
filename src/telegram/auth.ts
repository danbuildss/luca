export type AuthedUser = {
  userId: string;
  telegramId: number;
  timezone: string;
  role: 'operator' | 'admin';
};

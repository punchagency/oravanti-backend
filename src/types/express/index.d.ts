declare global {
  namespace Express {
    interface Request {
      // Adjust the type of 'user' to match whatever Better Auth returns
      user: {
        id: string;
        email: string;
        [key: string]: any;
      };
    }
  }
}

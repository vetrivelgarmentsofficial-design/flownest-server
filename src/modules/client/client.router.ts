import { Router } from 'express';

const router = Router();

// Placeholder routes for client module
router.get('/', (req, res) => {
  res.json({ message: 'Get Clients list endpoint' });
});

router.post('/', (req, res) => {
  res.json({ message: 'Create Client endpoint' });
});

export default router;

import { Router } from 'express';

const router = Router();

// Placeholder routes for follow-ups module
router.get('/', (req, res) => {
  res.json({ message: 'Get Follow-Ups list endpoint' });
});

router.post('/', (req, res) => {
  res.json({ message: 'Schedule Follow-Up endpoint' });
});

export default router;

import { Router } from 'express';

const router = Router();

// Placeholder routes for sales module
router.get('/', (req, res) => {
  res.json({ message: 'Get Sales list endpoint' });
});

router.post('/', (req, res) => {
  res.json({ message: 'Record Sale endpoint' });
});

export default router;

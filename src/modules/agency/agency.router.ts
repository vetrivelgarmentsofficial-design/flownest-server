import { Router } from 'express';

const router = Router();

// Placeholder routes for agency module
router.get('/', (req, res) => {
  res.json({ message: 'Agency Details endpoint' });
});

router.put('/', (req, res) => {
  res.json({ message: 'Update Agency details endpoint' });
});

export default router;

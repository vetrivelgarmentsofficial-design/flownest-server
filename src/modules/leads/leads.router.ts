import { Router } from 'express';

const router = Router();

// Placeholder routes for leads module
router.get('/', (req, res) => {
  res.json({ message: 'Get Leads list endpoint' });
});

router.post('/', (req, res) => {
  res.json({ message: 'Create Lead endpoint' });
});

export default router;

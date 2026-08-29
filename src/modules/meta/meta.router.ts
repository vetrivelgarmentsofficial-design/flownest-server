import { Router } from 'express';

const router = Router();

// Placeholder routes for Meta API webhook and integration
router.get('/webhook', (req, res) => {
  res.send('Meta Webhook validation endpoint');
});

router.post('/webhook', (req, res) => {
  res.send('Meta Webhook event receiver endpoint');
});

export default router;

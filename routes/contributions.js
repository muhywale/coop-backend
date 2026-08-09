import express from 'express';
import {
  getContributions,
  getContributionsByMember,
  createContribution,
  deleteContribution,
  getMemberBalance,
} from '../controllers/contributionsController.js';

const router = express.Router();

router.get('/', getContributions);
router.get('/member/:memberId', getContributionsByMember);
router.post('/', createContribution);
router.delete('/:id', deleteContribution);
router.get('/balance/:memberId', getMemberBalance);

export default router;

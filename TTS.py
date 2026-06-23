import torch
from transformers import SpeechT5Processor, SpeechT5ForTextToSpeech
from transformers.models.speecht5 import SpeechT5HifiGan
import re
from scipy.io.wavfile import write
import string
from num2words import num2words
import numpy as np
from datetime import datetime
from pathlib import Path

# ------------------------------
# Load model, processor, vocoder
# ------------------------------

processor = SpeechT5Processor.from_pretrained(
    r"C:\Users\User\Documents\Fine_Tuning_Projects\TTS_Project\First_american_accent\speecht5_finetuned_voxpopuli_nl\checkpoint-8648"
)

model = SpeechT5ForTextToSpeech.from_pretrained(
    r"C:\Users\User\Documents\Fine_Tuning_Projects\TTS_Project\First_american_accent\speecht5_finetuned_voxpopuli_nl\checkpoint-8648",
    use_safetensors=True,
    trust_remote_code=True
)

vocoder = SpeechT5HifiGan.from_pretrained(
    r"C:\Users\User\Documents\VERA\local_vocoder"
)

device = "cuda" if torch.cuda.is_available() else "cpu"
model = model.to(device)
vocoder = vocoder.to(device)

# ------------------------------
# Speaker embedding
# ------------------------------
speaker_embedding = torch.tensor([[-7.8568e-02, -4.2079e-03,  1.1993e-02,  1.2876e-02,  3.8205e-03,
         -1.9735e-03, -6.8052e-02, -6.2425e-02,  4.2591e-02,  2.0495e-02,
         -6.5605e-02, -7.4267e-02,  4.7141e-02,  3.1141e-02,  3.3795e-02,
          6.8717e-02,  1.5437e-02,  2.9659e-02,  9.6837e-03,  1.6690e-02,
          4.1287e-02,  1.0799e-02, -1.4346e-02, -3.6507e-02, -6.9912e-02,
         -1.1495e-02, -5.9190e-02,  5.0997e-03,  3.5220e-02,  2.7239e-02,
         -3.0035e-03,  4.0179e-02,  2.7811e-02, -3.7754e-02,  4.2270e-02,
         -7.6790e-02,  3.3923e-02,  5.8342e-02, -6.8696e-02, -6.8298e-02,
         -1.5029e-03, -5.7018e-02, -4.0267e-03,  5.2543e-02,  1.2046e-02,
         -1.1127e-01, -1.9529e-02,  1.1586e-02, -7.0273e-02,  5.7403e-02,
          1.9700e-02,  3.5813e-02,  3.8164e-02,  4.1581e-02, -7.9466e-02,
         -4.0844e-03,  4.3121e-02,  2.5432e-02,  1.6693e-02,  1.4494e-02,
          3.2961e-02, -1.0050e-02, -1.6570e-02,  2.1572e-02,  2.3886e-02,
          3.7505e-02,  2.3737e-03, -3.5667e-02, -6.9384e-02, -6.1990e-02,
          2.1427e-02,  1.0910e-02, -4.4866e-03,  1.9126e-02,  3.5026e-02,
          2.6617e-02,  1.0270e-02,  1.7574e-02, -5.0846e-02, -7.9475e-02,
         -5.9455e-02, -5.5634e-02, -5.4523e-02, -6.2594e-02, -3.4710e-02,
         -4.8424e-02, -6.5559e-02,  4.3848e-02, -8.9867e-06,  5.7124e-02,
          2.9633e-02, -8.8773e-02,  8.2799e-03, -6.3414e-02,  2.7484e-02,
          6.6257e-03,  3.2360e-02,  3.4513e-02, -2.0671e-02, -8.1817e-02,
          4.1832e-02, -6.9010e-02, -5.7109e-02,  5.1551e-02,  3.6937e-02,
         -5.9055e-02,  2.5737e-02,  4.8279e-02,  4.0342e-02,  2.0409e-02,
         -7.8760e-02,  4.8960e-02,  6.1605e-02,  1.5055e-03,  4.4753e-02,
          5.1425e-02, -6.9668e-02, -3.3952e-02, -5.3081e-02, -3.3253e-02,
          2.1449e-02, -7.3866e-02,  1.5239e-02,  3.7210e-02, -7.0857e-02,
          4.2094e-02, -7.8425e-02,  2.2612e-02,  4.6070e-02,  3.1248e-02,
          2.1681e-02,  9.0710e-03,  2.6234e-02,  3.9768e-02,  2.6416e-02,
         -5.9739e-02, -5.3194e-02,  1.1592e-02, -7.3099e-02, -4.0911e-02,
          2.9276e-02,  4.0793e-03, -2.7053e-02,  4.3887e-02, -7.4993e-02,
          2.8244e-02,  1.4546e-02, -5.5933e-02,  5.4590e-02, -9.8596e-02,
          2.3044e-02, -4.3384e-02, -6.2760e-02,  4.9645e-02,  1.9709e-02,
          2.2457e-02,  1.0992e-02, -9.1083e-02, -7.2880e-02,  5.3015e-02,
          1.4966e-02,  7.6749e-03,  1.2842e-02, -6.0044e-02,  1.4364e-03,
          1.2117e-02,  3.7999e-02,  4.1830e-02,  1.7146e-02,  4.1624e-02,
          1.9113e-02, -8.6394e-02,  3.9947e-02, -4.5318e-02, -1.5646e-02,
          1.7320e-02, -5.8261e-02,  1.3057e-02,  1.7871e-02, -7.2801e-02,
          2.7487e-02, -5.1378e-02,  1.0601e-02,  3.2772e-02, -3.3645e-02,
         -9.6321e-03,  5.7508e-02,  3.8802e-02, -5.4275e-02, -6.4749e-02,
         -2.3990e-02,  4.4422e-02, -5.5291e-02,  2.1329e-02,  3.5870e-02,
          1.5788e-02,  1.9083e-02, -2.5848e-03,  3.0792e-02, -2.4433e-02,
          4.0921e-02,  2.2340e-02, -4.7077e-02,  5.6612e-03,  2.4069e-02,
          1.7687e-02,  5.2614e-02, -1.4121e-02,  4.4471e-02, -4.5358e-02,
          3.0660e-03, -8.4165e-02, -4.3935e-02,  5.7635e-02, -4.6062e-02,
          2.8475e-02,  2.7438e-02, -7.8207e-02,  3.6834e-02,  3.5305e-02,
         -7.9270e-02,  1.5048e-02, -7.7217e-02, -3.3846e-02,  4.0682e-02,
          4.5813e-02,  6.3953e-02,  8.8146e-02,  3.9316e-02,  3.6404e-02,
         -3.6674e-02,  3.9037e-02,  3.2509e-02, -3.3039e-02,  9.0764e-03,
         -1.9967e-02,  3.4478e-02,  2.2831e-02, -6.8772e-04,  5.4448e-02,
         -6.7131e-02,  2.6475e-02, -9.6572e-02,  2.7054e-02, -6.1189e-02,
          4.2293e-02,  5.5649e-02,  2.4348e-02,  6.6935e-03,  4.2651e-02,
          3.7361e-02,  3.3392e-02,  9.3010e-03, -5.7520e-02,  5.3737e-03,
          4.5707e-02,  2.8316e-02, -1.5346e-03, -6.4626e-02,  5.0692e-02,
          1.4295e-02, -5.4578e-02,  3.8668e-02,  2.1647e-02,  1.4004e-03,
          2.3282e-02,  3.1919e-02,  1.2071e-02,  1.3926e-02, -4.4616e-02,
          4.2064e-02, -1.8788e-02,  1.6830e-02, -1.6330e-02, -6.7638e-02,
          4.5764e-02,  1.6224e-02,  1.3495e-02, -7.7807e-02, -4.8269e-02,
         -2.7209e-02,  5.7491e-02,  3.6628e-02, -8.6239e-02, -5.5271e-02,
          3.9839e-02,  1.0211e-03,  5.5201e-02, -9.7384e-02,  3.8847e-03,
          1.0693e-02,  7.5698e-03, -5.3666e-02,  4.1555e-02, -3.2620e-02,
          3.2532e-02,  7.4491e-03,  3.6136e-02,  1.7120e-02,  2.5016e-02,
          6.8792e-02,  2.9997e-02,  2.1673e-02, -7.8844e-02,  1.1353e-02,
          3.5831e-02,  3.0084e-02,  3.0417e-02,  2.9927e-02,  2.1848e-02,
          4.9556e-02,  2.2132e-02, -2.8324e-02,  4.4158e-02, -8.2102e-02,
         -6.4570e-02, -2.4734e-02,  3.2701e-02, -7.0163e-02,  5.4873e-02,
         -4.7028e-02,  4.4843e-02, -4.5314e-02,  1.0327e-02,  2.8297e-02,
         -5.7504e-02,  4.7179e-02,  7.4731e-02, -6.5681e-02, -8.6343e-02,
         -6.4412e-02,  3.1260e-02,  1.6076e-02,  4.7171e-02, -7.1781e-02,
          4.2377e-02,  3.9755e-02, -3.6226e-02, -7.4231e-03, -6.4577e-02,
          3.0569e-02, -5.3078e-02,  2.7852e-02, -7.6148e-03, -7.3751e-02,
          2.0000e-02,  2.1321e-02,  1.5519e-02, -3.6516e-02, -5.5269e-02,
         -4.3193e-02, -1.7178e-02, -5.1271e-02,  1.0353e-01,  4.1393e-02,
         -4.7789e-02, -8.0428e-03,  2.9483e-02, -5.4314e-02,  1.0356e-02,
         -1.0647e-01,  2.6810e-02, -1.3466e-02, -9.5602e-04,  5.6365e-02,
         -3.4805e-02, -4.8433e-02,  5.5901e-03,  1.0095e-02,  4.4062e-02,
          1.3886e-02,  2.7514e-02, -9.5484e-02,  1.4190e-02, -1.3233e-02,
         -2.4893e-03,  2.6416e-02,  6.7407e-03,  6.1025e-02,  3.8437e-02,
         -7.4136e-02, -1.1276e-01,  1.3998e-02,  4.5844e-02,  1.8342e-02,
         -6.7303e-02,  2.9729e-02, -6.0356e-02,  3.4768e-02,  2.6196e-02,
          5.8514e-03,  7.3593e-03, -4.2139e-02,  3.0210e-02,  1.5900e-02,
          7.0803e-03,  3.3725e-02, -8.8192e-02,  1.3683e-03,  1.4380e-02,
         -1.8023e-02, -6.0320e-02,  1.4030e-02, -4.0541e-02,  4.6965e-03,
          7.1572e-03,  1.0316e-02, -7.6909e-02, -5.5507e-02, -6.4332e-02,
         -6.2764e-02,  2.3172e-02,  1.5215e-02, -1.5576e-02,  2.3396e-02,
         -5.4251e-02,  1.7465e-02, -9.1552e-02, -1.4350e-01, -1.5228e-02,
         -5.0016e-02,  1.5546e-02,  1.9486e-02, -2.2702e-02, -6.0833e-02,
          1.8424e-02,  4.1719e-02,  3.1578e-02,  2.6568e-02, -4.9155e-02,
         -5.2004e-02, -1.8590e-02, -2.7371e-02,  3.8227e-02,  3.2638e-02,
          7.9873e-03,  4.5671e-02,  2.4781e-02, -6.7724e-02, -7.6685e-02,
          1.3213e-02,  1.9150e-02,  2.0911e-02,  4.8548e-03,  5.5948e-02,
          2.9883e-02,  2.2585e-02,  1.0647e-02,  9.4530e-03, -1.6939e-02,
          4.8591e-02,  2.6256e-02,  4.8367e-02,  5.7640e-02,  1.4820e-02,
          1.0206e-02,  2.1576e-02, -6.3301e-02, -6.1438e-02,  4.9681e-02,
         -1.4290e-02,  9.2644e-03,  4.7036e-02,  2.7807e-02, -4.7537e-02,
          2.8718e-02,  3.9035e-02, -6.9315e-02,  2.0267e-02,  9.3887e-03,
         -2.3518e-03,  3.0030e-02,  2.0438e-02,  4.7360e-03, -1.5699e-02,
         -7.5235e-02,  1.8405e-02, -5.7478e-03,  2.8843e-02,  4.1911e-02,
         -6.1657e-02, -5.3779e-02,  1.2746e-02,  2.4689e-02,  2.3149e-02,
          3.2983e-02, -5.4079e-02,  2.3033e-02, -1.2222e-02, -1.3194e-02,
         -4.7920e-02,  3.9478e-02, -5.1594e-02,  1.0203e-02,  8.6237e-04,
         -1.2024e-03, -5.9529e-02,  1.3870e-02, -6.7391e-02, -7.4410e-02,
          9.1564e-03,  2.5374e-02, -8.6928e-02,  3.2397e-02, -4.7997e-02,
         -1.4516e-02, -6.2727e-02,  4.8488e-02,  6.5368e-02, -2.2742e-02,
          3.6199e-02, -7.3590e-02]]).to(device)
# speaker_embedding = torch.tensor([[-0.0743, -0.0103,  0.0260,  0.0237,  0.0045, -0.0173, -0.0721, -0.0579,
#           0.0374,  0.0206, -0.0648, -0.0665,  0.0259,  0.0414,  0.0323,  0.0512,
#          -0.0078,  0.0259,  0.0123,  0.0155,  0.0371,  0.0255, -0.0156, -0.0398,
#          -0.0612, -0.0098, -0.0582, -0.0046,  0.0377,  0.0320, -0.0028,  0.0450,
#           0.0136, -0.0471,  0.0584, -0.0672,  0.0124,  0.0591, -0.0767, -0.0775,
#           0.0142, -0.0590,  0.0407,  0.0436,  0.0238, -0.1164, -0.0200,  0.0116,
#          -0.0551,  0.0721,  0.0228,  0.0490,  0.0465,  0.0149, -0.0871, -0.0100,
#           0.0324,  0.0294,  0.0441,  0.0122,  0.0189, -0.0091, -0.0154,  0.0116,
#           0.0376,  0.0224,  0.0141, -0.0388, -0.0615, -0.0467,  0.0216,  0.0115,
#           0.0205,  0.0136,  0.0419,  0.0258,  0.0181,  0.0173, -0.0678, -0.0821,
#          -0.0862, -0.0480, -0.0566, -0.0387, -0.0345, -0.0636, -0.0453,  0.0519,
#           0.0190,  0.0681,  0.0282, -0.0694, -0.0032, -0.0608,  0.0649, -0.0070,
#           0.0200,  0.0304, -0.0486, -0.0640,  0.0396, -0.1017, -0.0794,  0.0478,
#           0.0425, -0.0547,  0.0486,  0.0480,  0.0169,  0.0227, -0.0807,  0.0313,
#           0.0611, -0.0058,  0.0498,  0.0242, -0.0534, -0.0267, -0.0341, -0.0348,
#           0.0220, -0.0662,  0.0370,  0.0365, -0.0660,  0.0279, -0.0644,  0.0143,
#           0.0326,  0.0500,  0.0300,  0.0072,  0.0336,  0.0345,  0.0276, -0.0646,
#          -0.0484, -0.0059, -0.0605,  0.0012,  0.0081,  0.0036, -0.0033,  0.0463,
#          -0.0506,  0.0270, -0.0066, -0.0609,  0.0493, -0.1155,  0.0447, -0.0371,
#          -0.0567,  0.0285,  0.0146,  0.0203,  0.0108, -0.0639, -0.0762,  0.0279,
#           0.0205,  0.0018,  0.0158, -0.0595, -0.0299,  0.0084,  0.0270,  0.0379,
#           0.0132,  0.0510,  0.0261, -0.0636,  0.0276, -0.0498,  0.0167,  0.0027,
#          -0.0372,  0.0067,  0.0527, -0.0707,  0.0391, -0.0644,  0.0172,  0.0347,
#          -0.0643, -0.0093,  0.0371,  0.0346, -0.0542, -0.0589, -0.0141,  0.0344,
#          -0.0659,  0.0478,  0.0131,  0.0165,  0.0172,  0.0042,  0.0322, -0.0516,
#           0.0523,  0.0285, -0.0554,  0.0056, -0.0021,  0.0150,  0.0391, -0.0400,
#           0.0248, -0.0332,  0.0047, -0.0792, -0.0429,  0.0398, -0.0565,  0.0409,
#           0.0457, -0.0870,  0.0314,  0.0226, -0.0816,  0.0377, -0.0779, -0.0134,
#           0.0412,  0.0425,  0.0585,  0.0799,  0.0527,  0.0279, -0.0557,  0.0240,
#           0.0306, -0.0370,  0.0098, -0.0225,  0.0299,  0.0527, -0.0011,  0.0456,
#          -0.0768,  0.0237, -0.0966,  0.0106, -0.0521,  0.0512,  0.0424,  0.0236,
#           0.0301,  0.0044,  0.0502,  0.0307,  0.0095, -0.0570,  0.0166,  0.0166,
#           0.0321,  0.0367, -0.0677,  0.0514,  0.0165, -0.0601,  0.0407,  0.0401,
#           0.0020,  0.0015,  0.0574,  0.0310, -0.0053, -0.0610,  0.0391, -0.0212,
#           0.0271, -0.0256, -0.0613,  0.0301,  0.0564,  0.0209, -0.0815, -0.0544,
#          -0.0091,  0.0303,  0.0256, -0.0597, -0.0593,  0.0376,  0.0184,  0.0580,
#          -0.1039,  0.0021,  0.0159,  0.0319, -0.0386,  0.0322, -0.0432,  0.0292,
#           0.0096,  0.0047,  0.0127,  0.0264,  0.0627,  0.0366,  0.0212, -0.0772,
#           0.0303,  0.0400,  0.0267,  0.0290,  0.0309,  0.0488,  0.0430,  0.0153,
#          -0.0187,  0.0440, -0.0995, -0.0837, -0.0254,  0.0274, -0.0638,  0.0500,
#          -0.0568,  0.0611, -0.0643,  0.0084,  0.0148, -0.0675,  0.0311,  0.0652,
#          -0.0648, -0.0791, -0.0660,  0.0231,  0.0096,  0.0477, -0.0702,  0.0503,
#           0.0446, -0.0523, -0.0305, -0.0593,  0.0238, -0.0557,  0.0130,  0.0067,
#          -0.0756,  0.0354,  0.0289,  0.0261, -0.0466, -0.0584, -0.0441, -0.0355,
#          -0.0699,  0.1035,  0.0268, -0.0459, -0.0062,  0.0283, -0.0462,  0.0247,
#          -0.1061,  0.0222, -0.0052,  0.0058,  0.0479, -0.0126, -0.0533,  0.0160,
#           0.0042,  0.0476,  0.0133,  0.0263, -0.0822,  0.0167, -0.0129, -0.0026,
#           0.0359,  0.0130,  0.0528,  0.0397, -0.0638, -0.1078,  0.0214,  0.0292,
#           0.0351, -0.0545,  0.0406, -0.0787,  0.0306,  0.0389,  0.0332,  0.0178,
#          -0.0405,  0.0238,  0.0087,  0.0140,  0.0397, -0.0856, -0.0334, -0.0002,
#          -0.0025, -0.0352,  0.0299, -0.0384,  0.0179,  0.0057,  0.0005, -0.0593,
#          -0.0505, -0.0592, -0.0831,  0.0174,  0.0417, -0.0128,  0.0286, -0.0422,
#          -0.0141, -0.0779, -0.1574, -0.0493, -0.0533, -0.0075,  0.0274, -0.0474,
#          -0.0516,  0.0257,  0.0360,  0.0330,  0.0212, -0.0346, -0.0637, -0.0165,
#          -0.0254,  0.0295,  0.0180,  0.0093,  0.0260,  0.0096, -0.0626, -0.0537,
#           0.0172,  0.0479,  0.0311,  0.0023,  0.0482,  0.0456,  0.0232,  0.0089,
#          -0.0030, -0.0109,  0.0400,  0.0059,  0.0046,  0.0122,  0.0007, -0.0109,
#           0.0188, -0.0746, -0.0615,  0.0463, -0.0136,  0.0101,  0.0435,  0.0257,
#          -0.0516,  0.0282,  0.0218, -0.0788,  0.0135,  0.0192, -0.0027,  0.0225,
#           0.0103,  0.0045, -0.0529, -0.0672,  0.0158, -0.0058,  0.0440,  0.0572,
#          -0.0373, -0.0386,  0.0256,  0.0211,  0.0453,  0.0515, -0.0624,  0.0371,
#          -0.0205, -0.0121, -0.0542,  0.0136, -0.0411,  0.0284,  0.0219, -0.0009,
#          -0.0469, -0.0276, -0.0797, -0.0664,  0.0094,  0.0443, -0.0661,  0.0388,
#          -0.0244, -0.0143, -0.0674,  0.0379,  0.0583, -0.0234,  0.0413, -0.0651]]).to(device)

# ------------------------------
# Utilities
# ------------------------------

def _token_length(text: str) -> int:
    return processor(text=text, return_tensors="pt")["input_ids"].shape[1]


def _split_long_text(text: str, max_tokens: int) -> list[str]:
    words = text.split()
    if not words:
        return []

    chunks = []
    current = words[0]

    for word in words[1:]:
        candidate = f"{current} {word}".strip()
        if _token_length(candidate) <= max_tokens:
            current = candidate
        else:
            chunks.append(current)
            current = word

    if current:
        chunks.append(current)

    return chunks


def chunk_text(text, max_tokens=320):
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if _token_length(sentence) > max_tokens:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_text(sentence, max_tokens))
            continue

        candidate = (current + " " + sentence).strip()
        if _token_length(candidate) <= max_tokens:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = sentence

    if current:
        chunks.append(current)

    return chunks


def split_sentences_for_tts(text: str) -> list[str]:
    """
    Split a reply into segments for separate TTS files: paragraphs first (blank lines),
    then sentence ends (. ! ?) and single newlines inside a paragraph.
    Also fixes common LLM output with no space after a period (e.g. "foods.Use").
    """
    text = (text or "").strip()
    if not text:
        return []
    # Fancy quotes / fullwidth period → ASCII (avoids odd boundaries)
    text = text.replace("\u201c", '"').replace("\u201d", '"').replace("\u2019", "'")
    text = text.replace("\u3002", ".")
    # Glued sentences: lowercase letter + "." + uppercase (missing space)
    text = re.sub(r"(?<=[a-z])\.(?=[A-Z])", ". ", text)

    # News / structured replies often use blank lines between blocks — split those first.
    paragraphs = re.split(r"\n\s*\n+", text)
    out: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        parts = re.split(r"(?<=[.!?])\s+|\n+", para)
        for p in parts:
            p = p.strip()
            if p:
                out.append(p)
    return out if out else [text]


def pop_first_complete_segment(buffer: str) -> tuple[str | None, str]:
    """
    Incremental sentence split for streaming LLM: if buffer contains at least two
    TTS segments (same rules as split_sentences_for_tts), return (first, remainder).
    Otherwise (None, buffer) and wait for more tokens or flush at stream end.
    """
    if not (buffer or "").strip():
        return None, buffer
    segs = split_sentences_for_tts(buffer)
    if len(segs) < 2:
        return None, buffer
    first = segs[0]
    b = buffer.lstrip()
    offset = len(buffer) - len(b)
    if b.startswith(first):
        rest = buffer[offset + len(first) :].lstrip()
        return first, rest
    pos = buffer.find(first)
    if pos >= 0:
        rest = buffer[pos + len(first) :].lstrip()
        return first, rest
    return None, buffer


# ------------------------------
# MAIN TTS FUNCTION (UPDATED)
# ------------------------------

def speak_to_file(text: str, output_path: Path) -> Path:
    """
    Generate speech audio from text and write to output_path.
    output_path MUST be provided by the caller.
    Returns the output_path.
    """
    original_reply = text

    # Ensure parent directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # =========================
    # TEXT NORMALIZATION
    # =========================

    text = re.sub(r"\bvera\b", "vairah", text, flags=re.IGNORECASE)
    text = re.sub(r"\bnam\b", "nom", text, flags=re.IGNORECASE)
    # Replace e.g. with "for example" in all forms
    text = re.sub(r'e\.g\.', 'for example', text, flags=re.IGNORECASE)
    text = re.sub(r'i\.e\.', 'that is', text, flags=re.IGNORECASE)
    def replace_decimals(match):
        num = match.group()
        return num.replace('.', ' point ')

    # Replace decimal numbers first
    text = re.sub(r'\b\d+\.\d+\b', replace_decimals, text)
    def remove_commas_in_numbers(text: str) -> str:
    # Replace commas that are between digits with nothing
        return re.sub(r'(?<=\d),(?=\d)', '', text)
    text = remove_commas_in_numbers(text)

    def remove_hyphens_between_words(text: str) -> str:
    # Replace hyphens (with optional spaces around) that are between words with a single space
        return re.sub(r'(?<=[A-Za-z])\s*-\s*(?=[A-Za-z])', ' ', text)

    text = remove_hyphens_between_words(text)

    def replace_x_multiplication(text: str) -> str:
        # Replace lowercase x between two numbers with *
        return re.sub(r'(?<=\d)\s*[xX]\s*(?=\d)', ' * ', text)
    text = replace_x_multiplication(text)

    def fix_numeric_hyphens(text: str) -> str:
        # Case 1: numeric ranges like "250-500 calories" → "250 to 500 calories"
        text = re.sub(r'(\$?\d+)\s*-\s*(\$?\d+)', lambda m: f"{m.group(1)} to {m.group(2)}", text)

        # Case 2: pure math expression (digit - digit) → "minus"
        text = re.sub(r'(?<=\d)\s*-\s*(?=\d)', ' minus ', text)

        return text
    text = fix_numeric_hyphens(text)

    def replace_dollars(match):
        amount = match.group(1)
        words = num2words(int(amount))
        return f"{words} dollars"
    
    text = re.sub(r'\$(\d+)', replace_dollars, text)

    def normalize_subscript_numbers(text: str) -> str:
        subscript_map = {
            "₀": "0",
            "₁": "1",
            "₂": "2",
            "₃": "3",
            "₄": "4",
            "₅": "5",
            "₆": "6",
            "₇": "7",
            "₈": "8",
            "₉": "9"
        }
        # Replace any subscript characters with normal digits
        return ''.join(subscript_map.get(char, char) for char in text)
    text = normalize_subscript_numbers(text)

    def split_chemical_formulas(text: str) -> str:
        # Match pattern: one or more letters followed by one or more digits
        return re.sub(r'\b([A-Z]+)(\d+)\b', r'\1 \2', text)
    text = split_chemical_formulas(text)

    def replace_numbers(match):
        num = match.group()
        return num2words(int(num))
    
    text = re.sub(r'\b\d+\b', replace_numbers, text)

    letter_map = {
        'A': 'ay', 'B': 'bee', 'C': 'cee', 'D': 'dee', 'E': 'ee', 'F': 'ef', 'G': 'gee',
        'H': 'aitch', 'I': 'eye', 'J': 'jay', 'K': 'kay', 'L': 'el', 'M': 'em', 'N': 'en',
        'O': 'oh', 'P': 'pee', 'Q': 'cue', 'R': 'ar', 'S': 'ess', 'T': 'tee', 'U': 'you',
        'V': 'vee', 'W': 'double you', 'X': 'ex', 'Y': 'why', 'Z': 'zee'
    }

    known_acronyms = {
        "NASA": "NAHSA",
        "UNESCO": "Yoo Neh SKOW",
        "NATO": "NAYTOH",
        "RADAR": "RAYDAR",
        "SCUBA": "scuba",
        "≠": "does not equal",
        "°C": "degrees Celsius",
        "°F": "degrees Fahrenheit",
    }

    def replace_all_caps(match):
        word = match.group()
        if word in known_acronyms:
            return known_acronyms[word]  # use custom pronunciation
        else:
            # spell out each letter for unknown acronyms
            spelled = ' '.join(letter_map.get(c, c) for c in word if c in string.ascii_uppercase)
            return spelled
    text = re.sub(r'\b[A-Z]{2,}\b', replace_all_caps, text)

    # =========================
    # CONTRACTION EXPANSION (TTS-only)
    # =========================
    # The T5/SpeechT5 voice mispronounces apostrophe contractions
    # ("aren't", "you're", "it's", ...). Expand them to full words before
    # the pronunciation overrides run so the spoken audio is natural.
    # Display text is unaffected — this only mutates the local ``text``
    # variable on the TTS path.
    contraction_expansions = {
        "aren't": "are not",
        "can't": "cannot",
        "couldn't": "could not",
        "didn't": "did not",
        "doesn't": "does not",
        "don't": "do not",
        "hadn't": "had not",
        "hasn't": "has not",
        "haven't": "have not",
        "isn't": "is not",
        "shouldn't": "should not",
        "wasn't": "was not",
        "weren't": "were not",
        "won't": "will not",
        "wouldn't": "would not",

        "I'm": "I am",
        "I've": "I have",
        "I'll": "I will",
        "I'd": "I would",

        "you're": "you are",
        "you've": "you have",
        "you'll": "you will",
        "you'd": "you would",

        "he's": "he is",
        "he'll": "he will",
        "he'd": "he would",

        "she's": "she is",
        "she'll": "she will",
        "she'd": "she would",

        "it's": "it is",
        "it'll": "it will",
        "it'd": "it would",

        "we're": "we are",
        "we've": "we have",
        "we'll": "we will",
        "we'd": "we would",

        "they're": "they are",
        "they've": "they have",
        "they'll": "they will",
        "they'd": "they would",

        "that's": "that is",
        "that'll": "that will",
        "that'd": "that would",

        "there's": "there is",
        "there'll": "there will",
        "there'd": "there would",

        "what's": "what is",
        "what're": "what are",
        "what'll": "what will",
        "what'd": "what did",

        "where's": "where is",
        "where're": "where are",
        "where'll": "where will",
        "where'd": "where did",

        "when's": "when is",
        "when'll": "when will",
        "when'd": "when did",

        "why's": "why is",
        "why'll": "why will",
        "why'd": "why did",

        "how's": "how is",
        "how'll": "how will",
        "how'd": "how did",

        "who's": "who is",
        "who'll": "who will",
        "who'd": "who would",

        "let's": "let us",
        "y'all": "you all",
        "o'clock": "of the clock",
    }

    def expand_contractions_for_tts(s: str) -> str:
        # Normalize curly apostrophes to straight ones so dictionary
        # lookups based on ASCII apostrophes match streamed LLM output.
        s = s.replace("\u2019", "'")
        for contraction, expanded in contraction_expansions.items():
            # ``\b`` is unsafe here because ``'`` is not a word character
            # and would create boundaries inside contractions. The
            # ``(?<!\w)`` / ``(?!\w)`` lookarounds give us a true
            # word-edge match that respects apostrophes.
            pattern = r"(?<!\w)" + re.escape(contraction) + r"(?!\w)"
            s = re.sub(pattern, expanded, s, flags=re.IGNORECASE)
        return s

    text = expand_contractions_for_tts(text)

    mispronounced_words = {
        "radar": "raydar",
        "queue": "kyoo",
        "pizza": "peet zah",
        "buses": "buhses",
        "epitome": "ih pit uh me",
        "avocados": "av uh cah dough",
        "Python": "Pie thon",
        "dataset": "data set",
        "Mega": "MAY Gah",
        "Console": "Con sole",
        "Giga": "Gig Gah",
        "GigaBytes": "GigGa Bytes",
        "GigaByte": "GigGa Byte",
        "Pythagorean": "Pie thagorean",
        "Vietnam": "Vee et nom",
        "Saigon": "Sigh gon",
        "double bass": "double base",
        "base": "base",
        "Irvine": "Ir-vine",
        "Celcius": "Sell see us",
        "anime": "ah-knee-may",
        "email" : "e-mail",
        "parameters": "puhrammiters",
        "chaos": "kay os",
        "reset": "re set"
    }

    def replace_mispronounced(text: str) -> str:
        # Use regex to match whole words only, case-insensitive
        for word, replacement in mispronounced_words.items():
            pattern = r'\b' + re.escape(word) + r'\b'
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
        return text
    text = replace_mispronounced(text)
    
    def remove_double_stars(text: str) -> str:
        # Remove ** only when there's real content between them (avoids emptying text)
        return re.sub(r'\*\*([^*]+?)\*\*', r'\1', text)
    text = remove_double_stars(text)

    symbol_map = {
        '+': 'plus',
        '*': 'times',
        '/': 'divided by',
        '=': 'equals',
        '@': 'at',
        '&': 'and',
        '%': 'percent',
        '#': 'hash',
        '^': 'to the power of',
        '<': 'is less than',
        '>': 'is greater than',
        '_': 'underscore',
    }

    for sym, word in symbol_map.items():
        text = text.replace(sym, f" {word} ")

    text = text.strip()
    if not text:
        print(f"[TTS] WARN: Empty text after normalization. Raw reply was: {repr(original_reply)}")
        write(output_path, 16000, np.zeros(1600, dtype=np.int16))
        return output_path

    # =========================
    # TTS GENERATION
    # =========================

    chunks = chunk_text(text)
    audio_chunks = []

    for chunk in chunks:
        inputs = processor(text=chunk, return_tensors="pt").to(device)

        with torch.no_grad():
            waveform = model.generate_speech(
                inputs["input_ids"],
                speaker_embedding,
                vocoder=vocoder,
            )

        audio_chunks.append(waveform.squeeze().cpu().numpy())

    if not audio_chunks:
        # No audio produced (e.g. chunk_text returned empty): write minimal silent WAV
        print(f"[TTS] WARN: No audio chunks (chunk_text returned empty). Raw reply was: {repr(original_reply)}")
        write(output_path, 16000, np.zeros(1600, dtype=np.int16))  # 0.1s silence
        return output_path

    # Concatenate chunks
    final_audio = np.concatenate(audio_chunks)

    # Normalize to int16
    final_audio = np.clip(final_audio, -1.0, 1.0)
    final_audio = (final_audio * 32767).astype(np.int16)

    # Write WAV
    write(output_path, 16000, final_audio)

    return output_path

# base = Path(r"C:\Users\User\Documents\VERA\Online_demo\static\fillers")

# speak_to_file(
#     "Give me a moment, sir.",
#     base / "moment.wav"
# )

# speak_to_file(
#     "One second, sir.",
#     base / "one_second.wav"
# )

# speak_to_file(
#     "Give me a second, sir.",
#     base / "give_me_a_second.wav"
# )

# speak_to_file(
#     "One moment, sir.",
#     base / "one_moment.wav"
# )